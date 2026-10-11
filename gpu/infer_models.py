"""Isolated CUDA inference: free all model VRAM when each job exits."""
import argparse
import json
import math
from pathlib import Path

SHARP_CHECKPOINT = "https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"
DA3_MODEL = "depth-anything/DA3NESTED-GIANT-LARGE-1.1"


def predict_single(images, output):
    import torch
    from sharp.models import PredictorParams, create_predictor
    from sharp.cli.predict import predict_image
    from sharp.utils.io import load_rgb
    from sharp.utils.gaussians import save_ply
    device = torch.device("cuda")
    state = torch.hub.load_state_dict_from_url(SHARP_CHECKPOINT, map_location="cpu", progress=False)
    model = create_predictor(PredictorParams())
    model.load_state_dict(state)
    del state
    model = model.eval().to(device)
    image, _, focal = load_rgb(images[0])
    height, width = image.shape[:2]
    with torch.inference_mode():
        gaussians = predict_image(model, image, focal, device)
        save_ply(gaussians, focal, (height, width), output / "scene.ply")
    distance = float(gaussians.mean_vectors[..., 2].median().cpu())
    return {"model": "Apple SHARP", "ply": "scene.ply", "camera": {"position": [0, 0, 0], "target": [0, 0, max(.1, distance)], "up": [0, -1, 0],
        "fov": math.degrees(2 * math.atan(height / (2 * focal))), "aspect": width / height}}


def predict_multiview(images, output, process_res):
    import numpy as np
    import torch
    from depth_anything_3.api import DepthAnything3
    from depth_anything_3.utils.gsply_helpers import save_gaussian_ply
    model = DepthAnything3.from_pretrained(DA3_MODEL).to("cuda")
    with torch.inference_mode():
        prediction = model.inference(image=[str(path) for path in images], infer_gs=True,
            process_res=process_res)
        depth = torch.from_numpy(prediction.depth).unsqueeze(-1).to(prediction.gaussians.means)
        save_gaussian_ply(prediction.gaussians, str(output / "scene.ply"), depth,
            prune_by_depth_percent=1.0, prune_border_gs=False)
    extrinsic = np.asarray(prediction.extrinsics[0], dtype=np.float64)
    rotation, translation = extrinsic[:3, :3], extrinsic[:3, 3].copy()
    scale = getattr(prediction, "scale_factor", None)
    scale = float(scale) if getattr(prediction, "is_metric", False) and scale is not None else 1.0
    translation /= scale
    position = -rotation.T @ translation
    distance = max(.1, float(np.median(prediction.depth[0])) / scale)
    target = position + rotation.T @ np.array([0, 0, distance])
    up = rotation.T @ np.array([0, -1, 0])
    height, width = prediction.depth.shape[-2:]
    focal = float(prediction.intrinsics[0][1, 1])
    return {"model": "Depth Anything 3 Nested Giant Large 1.1", "ply": "scene.ply", "camera": {"position": position.tolist(), "target": target.tolist(), "up": up.tolist(),
        "fov": math.degrees(2 * math.atan(height / (2 * focal))), "aspect": width / height}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--process-res", type=int, choices=(336, 420, 504), default=420)
    args = parser.parse_args()
    images = sorted(args.input.glob("*.png"))
    if not 1 <= len(images) <= 6:
        raise ValueError("Expected one to six independent camera views")
    args.output.mkdir(parents=True, exist_ok=True)
    result = predict_single(images, args.output) if len(images) == 1 else predict_multiview(images, args.output, args.process_res)
    (args.output / "metadata.json").write_text(json.dumps(result), encoding="utf-8")
