# Shadow Gaussian service

The Entropi homepage calls `/api/reconstruct/health`, submits independent camera views, polls a job, and downloads the real Gaussian artifact in authenticated 2 MB ranges. Vercel forwards to the existing `GAUSS_BACKEND_URL` and keeps `GAUSS_BACKEND_TOKEN` on the server. The phone never receives that token.

One photo uses **Apple SHARP**, which predicts position, scale, rotation, opacity and colour. A held pan uses **Depth Anything 3 Nested Giant Large 1.1** with `infer_gs=True`, estimated camera poses and the official `gs_ply` exporter. The large 1.1 Gaussian head replaces the local Small depth model when this service is available. Eight distinct views are retained from each capture; they are not flattened into a panorama before reconstruction.

The local depth point cloud remains an explicitly identified fallback in screen-reader status if Shadow is offline. No visible text, settings or model controls are added to the phone UI.

## Start on a Windows Shadow PC

Install Python 3.11, Git and an NVIDIA driver compatible with CUDA 12.8. Pull this repository onto Shadow. In `gpu/.env`, reuse the **same** `GAUSS_BACKEND_TOKEN` configured on Vercel. Do not commit it or expose it in the browser.

From PowerShell, run:

```powershell
./gpu/start-shadow.ps1 -Port 8000
```

Use the port already targeted by the existing Tailscale Funnel. If the old model server occupies that port, stop that old service first. The script installs the pinned model repositories in a private virtual environment, downloads both checkpoints, checks CUDA and starts the service on localhost. Initial installation and checkpoint downloads may take several minutes.

If the existing Funnel is not configured, point it at that port using Tailscale's supported Funnel configuration. Keep the public hostname the same as `GAUSS_BACKEND_URL`. The service itself rejects unauthenticated calls.

## Linux alternative

Use Python 3.11, CUDA-capable PyTorch and one Uvicorn worker:

```sh
cd gpu
python3.11 -m venv .venv
.venv/bin/python -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
.venv/bin/python -m pip install -c constraints.txt -r requirements.txt -r model-requirements.txt
.venv/bin/python warm_models.py
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000 --env-file .env --workers 1
```

GPU inference is serialized, with one pending job and a 210 second worker timeout. Each model runs in a subprocess so its GPU memory is released after inference. Uploaded photos and intermediate PLY files are deleted immediately after the job. Packed artifacts expire after 30 minutes and all interrupted jobs are removed at restart. A `.splat` retains every model-predicted Gaussian parameter; ordinary XYZ point clouds are rejected.

SHARP's model is under Apple's Machine Learning Research Model license; the DA3 Giant weights are under CC BY-NC 4.0. This configuration is for the existing personal research camera. Review those model licenses before changing the use to a commercial product. Code and model repositories are pinned in `model-requirements.txt`.

## Verification

`python -m unittest discover -s tests -p 'gpu_*.py'` verifies authentication, capture uploads, the queued worker, actual Gaussian packing, bounded downloads and rejection of XYZ-only artifacts without requiring a GPU. Running inference on Shadow and a physical PX10 print still require those devices.
