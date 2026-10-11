"""Private Shadow GPU service. Vercel holds the bearer token; iPhone never sees it."""
import asyncio
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageOps
from pack_splats import pack_ply

MAX_UPLOAD = 4_000_000
MAX_PART = 2_000_000
TTL = 1800
ID = re.compile(r"^[a-zA-Z0-9_-]{8,128}$")


def model_ready():
    packages = ["torch", "sharp", "depth_anything_3"]
    if not all(importlib.util.find_spec(name) for name in packages):
        return False
    try:
        result = subprocess.run([sys.executable, "-c", "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"], timeout=20, capture_output=True)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


async def run_model(inputs, output, process_res):
    process = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).with_name("infer_models.py")),
        "--input", str(inputs), "--output", str(output), "--process-res", str(process_res),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    try:
        await asyncio.wait_for(process.wait(), timeout=210)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        raise RuntimeError("Model inference failed; check the installed CUDA/model dependencies")
    return json.loads((output / "metadata.json").read_text(encoding="utf-8"))


def save_result(artifact, destination, metadata):
    destination.parent.mkdir(parents=True, exist_ok=True)
    pending_artifact = destination.with_suffix(".splat.part")
    details = destination.with_suffix(".json")
    pending_details = details.with_suffix(".json.part")
    try:
        shutil.copyfile(artifact, pending_artifact)
        os.replace(pending_artifact, destination)
        pending_details.write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")
        os.replace(pending_details, details)
    finally:
        pending_artifact.unlink(missing_ok=True)
        pending_details.unlink(missing_ok=True)


def create_app(token=None, root=None, runner=run_model, ready=model_ready, save_root=None):
    token = token or os.environ.get("GAUSS_BACKEND_TOKEN") or os.environ.get("BACKEND_TOKEN")
    root = Path(root or os.environ.get("ENTROPI_JOBS_DIR", "./jobs")).resolve()
    save_root = Path(save_root or os.environ.get("ENTROPI_SAVE_DIR") or root / "saved").resolve()
    jobs = {}
    queue = asyncio.Queue(maxsize=1)
    available = False

    async def worker():
        while True:
            job = await queue.get()
            try:
                job.update(status="running", progress=20)
                folder = root / job["id"]
                metadata = await runner(folder / "input", folder / "output", job["process_res"])
                path = (folder / "output" / metadata["ply"]).resolve()
                if not path.is_relative_to(folder / "output"):
                    raise ValueError("Invalid model artifact")
                count, bounds = await asyncio.to_thread(pack_ply, path, folder / "scene.splat")
                artifact = folder / "scene.splat"
                digest = await asyncio.to_thread(lambda: hashlib.sha256(artifact.read_bytes()).hexdigest())
                camera = {**metadata["camera"], "bounds": bounds}
                result = {"model": metadata["model"], "camera": camera, "representation": "gaussian-splats",
                    "sizeBytes": artifact.stat().st_size, "sha256": digest, "splats": count, "process_res": job["process_res"]}
                name = time.strftime("%Y%m%d-%H%M%SZ", time.gmtime(job["created"])) + "-" + job["id"]
                await asyncio.to_thread(save_result, artifact, save_root / f"{name}.splat", result)
                job.update(status="succeeded", progress=100, **result)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"Gaussian job {job['id']} failed: {type(error).__name__}", file=sys.stderr)
                job.update(status="failed", error="Gaussian model inference failed")
            finally:
                shutil.rmtree(root / job["id"] / "input", ignore_errors=True)
                shutil.rmtree(root / job["id"] / "output", ignore_errors=True)
                queue.task_done()

    @asynccontextmanager
    async def lifespan(app):
        nonlocal available
        if not token or len(token) < 24:
            raise RuntimeError("Set GAUSS_BACKEND_TOKEN to the existing private Vercel backend token")
        root.mkdir(parents=True, exist_ok=True)
        save_root.mkdir(parents=True, exist_ok=True)
        # Interrupted jobs are never replayed after a service restart.
        for stale in root.iterdir():
            if stale.is_dir() and ID.fullmatch(stale.name):
                shutil.rmtree(stale)
        available = await asyncio.to_thread(ready)
        task = asyncio.create_task(worker())
        async def expire():
            while True:
                await asyncio.sleep(60)
                cleanup()
        expiry = asyncio.create_task(expire())
        yield
        task.cancel(); expiry.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        try:
            await expiry
        except asyncio.CancelledError:
            pass

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def authorize(authorization: str = Header(default="")):
        if not token or not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "Unauthorized")

    def cleanup():
        now = time.time()
        for identifier, job in list(jobs.items()):
            if job["status"] in ["succeeded", "failed"] and now - job["created"] > TTL:
                shutil.rmtree(root / identifier, ignore_errors=True)
                del jobs[identifier]

    def lookup(identifier):
        cleanup()
        if not ID.fullmatch(identifier) or identifier not in jobs:
            raise HTTPException(404, "Job not found")
        return jobs[identifier]

    @app.get("/api/reconstruct/health", dependencies=[Depends(authorize)])
    async def health():
        return {"ready": available, "representation": "gaussian-splats", "models": ["Apple SHARP", "depth-anything/DA3NESTED-GIANT-LARGE-1.1"]}

    @app.post("/api/reconstruct/jobs", status_code=202, dependencies=[Depends(authorize)])
    async def create(images: list[UploadFile] = File(), process_res: int = Form(420)):
        cleanup()
        if process_res not in (168, 224, 336, 420, 504):
            raise HTTPException(400, "Unsupported model resolution")
        if not available:
            raise HTTPException(503, "CUDA or model dependencies are unavailable")
        if not 1 <= len(images) <= 6:
            raise HTTPException(400, "Expected one to six images")
        if queue.full() or len(jobs) >= 32:
            raise HTTPException(429, "GPU queue is full")
        identifier = secrets.token_urlsafe(24)
        folder = root / identifier
        (folder / "input").mkdir(parents=True)
        size = 0
        try:
            for index, image in enumerate(images):
                if image.content_type not in ["image/jpeg", "image/png", "image/webp"]:
                    raise HTTPException(415, "Unsupported image")
                data = await image.read(MAX_UPLOAD + 1)
                size += len(data)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "Image upload exceeds the budget")
                def decode():
                    with Image.open(io.BytesIO(data)) as source:
                        if source.width * source.height > 20_000_000:
                            raise ValueError("Image resolution too high")
                        decoded = ImageOps.exif_transpose(source).convert("RGB")
                        decoded.thumbnail((1536, 1536))
                        decoded.save(folder / "input" / f"view-{index:02d}.png")
                await asyncio.to_thread(decode)
                await image.close()
            job = {"id": identifier, "created": time.time(), "status": "queued", "progress": 5, "process_res": process_res}
            jobs[identifier] = job
            # Re-check after decoding: another request may have filled the queue.
            try:
                queue.put_nowait(job)
            except asyncio.QueueFull:
                jobs.pop(identifier, None)
                raise HTTPException(429, "GPU queue is full")
            return {"id": identifier, "status": "queued"}
        except Exception as error:
            shutil.rmtree(folder, ignore_errors=True)
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(400, "Invalid image") from error
        finally:
            for image in images:
                await image.close()

    @app.get("/api/reconstruct/jobs/{identifier}", dependencies=[Depends(authorize)])
    async def status(identifier: str):
        return {key: value for key, value in lookup(identifier).items() if key not in ("created", "process_res")}

    @app.get("/api/reconstruct/jobs/{identifier}/artifact", dependencies=[Depends(authorize)])
    async def artifact(identifier: str, range: str = Header(default="")):
        job = lookup(identifier)
        if job["status"] != "succeeded":
            raise HTTPException(409, "Artifact is not ready")
        matched = re.fullmatch(r"bytes=(\d+)-(\d+)", range)
        if not matched:
            raise HTTPException(416, "A bounded byte range is required")
        start, end = map(int, matched.groups())
        if not 0 <= start <= end < job["sizeBytes"] or end - start + 1 > MAX_PART:
            raise HTTPException(416, "Invalid byte range")
        with (root / identifier / "scene.splat").open("rb") as file:
            file.seek(start)
            data = file.read(end - start + 1)
        return Response(data, status_code=206, media_type="application/octet-stream", headers={"Content-Range": f"bytes {start}-{end}/{job['sizeBytes']}", "Accept-Ranges": "bytes", "Cache-Control": "no-store"})

    return app


app = create_app()
