"""Download the pinned public assets used by the browser worker for local verification."""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'static/pointcloud/models/manifest.json').read_text())
cache = root / '.pointcloud-cache'
cache.mkdir(exist_ok=True)
for key, filename in [('asset', 'model.onnx'), ('runtime', 'runtime.wasm')]:
    spec = manifest[key]
    path = cache / filename
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == spec['sha256']:
        continue
    request = Request(spec['url'], headers={'User-Agent': 'entropi-pointcloud-verification/1'})
    with urlopen(request, timeout=60) as response:
        data = response.read()
    if len(data) != spec['bytes'] or hashlib.sha256(data).hexdigest() != spec['sha256']:
        raise RuntimeError(f'Invalid checksum for {filename}')
    path.write_bytes(data)
    print(f'Verified {filename}: {len(data)} bytes')
