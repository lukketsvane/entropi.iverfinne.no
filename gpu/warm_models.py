"""Download model checkpoints before serving phone captures, not during the first job."""
from huggingface_hub import snapshot_download
import torch
from infer_models import SHARP_CHECKPOINT, DA3_MODEL

if not torch.cuda.is_available():
    raise SystemExit("Shadow must expose an NVIDIA CUDA GPU")
torch.hub.load_state_dict_from_url(SHARP_CHECKPOINT, map_location="cpu", progress=True)
snapshot_download(DA3_MODEL)
