import io
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest

import numpy as np
from PIL import Image
from plyfile import PlyData, PlyElement
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gpu"))
from pack_splats import pack_ply
from app import create_app

TOKEN = "test-private-shadow-token-at-least-24-chars"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def gaussian_ply(path):
    names = ["x", "y", "z"] + [f"f_dc_{i}" for i in range(3)] + ["opacity"] + [f"scale_{i}" for i in range(3)] + [f"rot_{i}" for i in range(4)]
    vertices = np.zeros(1, dtype=[(name, "f4") for name in names])
    vertices["x"] = 1
    vertices["y"] = 2
    vertices["z"] = 3
    vertices["scale_0"] = np.log(.2)
    vertices["scale_1"] = np.log(.3)
    vertices["scale_2"] = np.log(.4)
    vertices["rot_0"] = 1
    PlyData([PlyElement.describe(vertices, "vertex")]).write(path)
    return vertices


class GaussianPacking(unittest.TestCase):
    def test_actual_covariance_rotation_opacity_colour_survive_packing(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.ply", Path(directory) / "scene.splat"
            gaussian_ply(source)
            self.assertEqual(pack_ply(source, output), 1)
            values = struct.unpack("<6f8B", output.read_bytes())
            self.assertEqual(values[:3], (1, 2, 3))
            np.testing.assert_allclose(values[3:6], [.2, .3, .4], rtol=1e-6)
            self.assertEqual(values[6:10], (128, 128, 128, 128))
            self.assertEqual(values[10:], (255, 128, 128, 128))

    def test_low_opacity_gaussian_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.ply", Path(directory) / "scene.splat"
            vertices = gaussian_ply(source)
            faint = vertices.copy()
            faint["x"] = 4
            faint["opacity"] = -10
            PlyData([PlyElement.describe(np.concatenate([vertices, faint]), "vertex")]).write(source)
            self.assertEqual(pack_ply(source, output), 2)
            self.assertEqual(len(output.read_bytes()), 64)
            self.assertEqual(struct.unpack_from("<f", output.read_bytes(), 32)[0], 4)

    def test_plain_xyz_point_cloud_cannot_impersonate_gaussian_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "points.ply"
            vertices = np.zeros(1, dtype=[(k, "f4") for k in ["x", "y", "z"]])
            PlyData([PlyElement.describe(vertices, "vertex")]).write(source)
            with self.assertRaisesRegex(ValueError, "not a Gaussian"):
                pack_ply(source, Path(directory) / "scene.splat")


class ShadowService(unittest.TestCase):
    def test_authenticated_capture_worker_and_chunked_artifact(self):
        seen = []
        async def predict(inputs, output):
            seen.extend(inputs.glob("*.png"))
            output.mkdir()
            gaussian_ply(output / "scene.ply")
            return {"ply": "scene.ply", "model": "synthetic test Gaussians", "camera": {"position": [0, 0, 0], "target": [0, 0, 3], "up": [0, -1, 0], "fov": 55}}
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(token=TOKEN, root=directory, runner=predict, ready=lambda: True)
            with TestClient(app) as client:
                self.assertEqual(client.get("/api/reconstruct/health").status_code, 401)
                self.assertEqual(client.get("/api/reconstruct/health", headers=AUTH).json()["representation"], "gaussian-splats")
                image = io.BytesIO()
                Image.new("RGB", (12, 12), "white").save(image, format="JPEG")
                response = client.post("/api/reconstruct/jobs", headers=AUTH, files=[("images", ("view.jpg", image.getvalue(), "image/jpeg"))])
                self.assertEqual(response.status_code, 202)
                identifier = response.json()["id"]
                path = f"/api/reconstruct/jobs/{identifier}"
                for _ in range(100):
                    job = client.get(path, headers=AUTH).json()
                    if job["status"] in ["succeeded", "failed"]:
                        break
                    time.sleep(.01)
                self.assertEqual(job["status"], "succeeded")
                self.assertEqual(job["sizeBytes"], 32)
                self.assertEqual(len(job["sha256"]), 64)
                self.assertEqual(len(seen), 1)
                artifact = client.get(path + "/artifact", headers={**AUTH, "Range": "bytes=0-31"})
                self.assertEqual(artifact.status_code, 206)
                self.assertEqual(artifact.headers["content-range"], "bytes 0-31/32")
                self.assertEqual(len(artifact.content), 32)
                self.assertEqual(client.get(path + "/artifact", headers=AUTH).status_code, 416)
                self.assertEqual(client.get(path + "/artifact", headers={**AUTH, "Range": "bytes=0-32"}).status_code, 416)
                self.assertFalse((Path(directory) / identifier / "input").exists())
                self.assertFalse((Path(directory) / identifier / "output").exists())

    def test_model_failures_never_publish_an_artifact(self):
        async def fail(inputs, output):
            raise RuntimeError("test model error")
        with tempfile.TemporaryDirectory() as directory:
            with TestClient(create_app(token=TOKEN, root=directory, runner=fail, ready=lambda: True)) as client:
                image = io.BytesIO()
                Image.new("RGB", (12, 12)).save(image, format="PNG")
                response = client.post("/api/reconstruct/jobs", headers=AUTH, files=[("images", ("view.png", image.getvalue(), "image/png"))])
                path = "/api/reconstruct/jobs/" + response.json()["id"]
                for _ in range(100):
                    job = client.get(path, headers=AUTH).json()
                    if job["status"] == "failed":
                        break
                    time.sleep(.01)
                self.assertEqual(job["status"], "failed")
                self.assertEqual(client.get(path + "/artifact", headers={**AUTH, "Range": "bytes=0-31"}).status_code, 409)


if __name__ == "__main__":
    unittest.main()
