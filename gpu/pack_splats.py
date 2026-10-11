"""Pack genuine model-produced 3DGS PLY parameters into a mobile-sized .splat artifact."""
from pathlib import Path
import numpy as np
from plyfile import PlyData

MAX_SPLATS = 1_200_000


def pack_ply(source: Path, destination: Path) -> int:
    vertices = PlyData.read(source)["vertex"].data
    required = ["x", "y", "z", "opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)] + [f"f_dc_{i}" for i in range(3)]
    if not set(required).issubset(vertices.dtype.names or ()):
        raise ValueError("The artifact is a point cloud, not a Gaussian scene")
    xyz = np.column_stack([vertices[k] for k in ["x", "y", "z"]])
    scales = np.exp(np.clip(np.column_stack([vertices[f"scale_{i}"] for i in range(3)]), -30, 20))
    rotations = np.column_stack([vertices[f"rot_{i}"] for i in range(4)])
    colours = .5 + .28209479177387814 * np.column_stack([vertices[f"f_dc_{i}"] for i in range(3)])
    opacity = 1 / (1 + np.exp(-np.clip(vertices["opacity"], -40, 40)))
    norm = np.linalg.norm(rotations, axis=1)
    valid = np.isfinite(xyz).all(axis=1) & np.isfinite(scales).all(axis=1) & np.isfinite(colours).all(axis=1) & np.isfinite(norm) & (norm > 1e-8) & (opacity >= .01)
    indices = np.flatnonzero(valid)
    if not len(indices):
        raise ValueError("No usable Gaussians were predicted")
    importance = np.prod(scales[indices], axis=1) * opacity[indices]
    indices = indices[np.argsort(importance)[::-1]][:MAX_SPLATS]
    records = np.empty(len(indices), dtype=np.dtype([("position", "<f4", (3,)), ("scale", "<f4", (3,)), ("rgba", "u1", (4,)), ("rotation", "u1", (4,))]))
    records["position"] = xyz[indices]
    records["scale"] = scales[indices]
    records["rgba"][:, :3] = np.clip(np.rint(colours[indices] * 255), 0, 255).astype(np.uint8)
    records["rgba"][:, 3] = np.clip(np.rint(opacity[indices] * 255), 0, 255).astype(np.uint8)
    records["rotation"] = np.clip(np.rint(128 + 128 * rotations[indices] / norm[indices, None]), 0, 255).astype(np.uint8)
    destination.write_bytes(records.tobytes())
    return len(records)
