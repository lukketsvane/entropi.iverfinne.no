param([int]$Port = 8000)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv/Scripts/python.exe")) {
  py -3.11 -m venv .venv
  if ($LASTEXITCODE -ne 0) { throw "Install Python 3.11 and Git on Shadow first." }
  & .venv/Scripts/python.exe -m pip install --upgrade pip
  & .venv/Scripts/python.exe -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw "CUDA PyTorch installation failed." }
}
& .venv/Scripts/python.exe -m pip install -c constraints.txt -r requirements.txt -r model-requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Model dependency installation failed." }
if (-not (Test-Path ".env")) { throw "Add GAUSS_BACKEND_TOKEN to gpu/.env using the existing private backend token." }
& .venv/Scripts/python.exe warm_models.py
if ($LASTEXITCODE -ne 0) { throw "Model download or GPU check failed." }
# Keep the existing Tailscale Funnel pointing to this localhost port.
& .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port $Port --env-file .env --workers 1
