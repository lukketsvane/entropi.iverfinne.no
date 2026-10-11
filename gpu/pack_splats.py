"""Pack genuine model-produced 3DGS PLY parameters into a mobile-sized .splat artifact."""
from pathlib import Path
import numpy as np
from plyfile import PlyData

def pack_ply(source: Path, destination: Path) -> int:
    vertices = PlyData.read(source)["vertex"].data
    required = ["x", "y", "z", "opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)] + [f"f_dc_{i}" for i in range(3)]
    if not set(required).issubset(vertices.dtype.names or ()):
        raise ValueError("The artifact is a point cloud, not a Gaussian scene")
    xyz = np.column_stack([vertices[k] for k in ["x", "y", "z"]])
    scales = np.exp(np.column_stack([vertices[f"scale_{i}"] for i in range(3)]))
    rotations = np.column_stack([vertices[f"rot_{i}"] for i in range(4)])
    colours = .5 + .28209479177387814 * np.column_stack([vertices[f"f_dc_{i}"] for i in range(3)])
    opacity = 1 / (1 + np.exp(-np.clip(vertices["opacity"], -40, 40)))
    norm = np.linalg.norm(rotations, axis=1)
    if not len(vertices) or not (np.isfinite(xyz).all() and np.isfinite(scales).all() and
        np.isfinite(colours).all() and np.isfinite(opacity).all() and np.isfinite(norm).all() and (norm > 1e-8).all()):
        raise ValueError("Invalid Gaussian parameters")
    records = np.empty(len(vertices), dtype=np.dtype([("position", "<f4", (3,)), ("scale", "<f4", (3,)), ("rgba", "u1", (4,)), ("rotation", "u1", (4,))]))
    records["position"] = xyz
    records["scale"] = scales
    records["rgba"][:, :3] = np.clip(np.rint(colours * 255), 0, 255).astype(np.uint8)
    records["rgba"][:, 3] = np.clip(np.rint(opacity * 255), 0, 255).astype(np.uint8)
    records["rotation"] = np.clip(np.rint(128 + 128 * rotations / norm[:, None]), 0, 255).astype(np.uint8)
    destination.write_bytes(records.tobytes())
    return len(records)
