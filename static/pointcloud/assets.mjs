const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('');

// Only public model/runtime files are fetched or cached. No camera data goes onto the network.
export async function loadAsset(asset, onProgress = () => {}, fetcher = fetch, cache = null) {
  let response = await cache?.match(asset.url);
  if (!response) response = await fetcher(asset.url, { cache: 'force-cache' });
  if (!response?.ok) throw new Error('Kunne ikkje laste 3D-modellen. Prøv igjen når du har nett.');
  const bytes = new Uint8Array(asset.bytes);
  let written = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (written + value.length > bytes.length) throw new Error('Ugyldig modellfil.');
        bytes.set(value, written); written += value.length;
        onProgress(Math.round(written / bytes.length * 100));
      }
    } finally { await reader.cancel().catch(() => {}); }
  } else {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > bytes.length) throw new Error('Ugyldig modellfil.');
    bytes.set(data); written = data.length;
  }
  if (written !== asset.bytes || await sha256(bytes) !== asset.sha256) {
    await cache?.delete(asset.url);
    throw new Error('3D-modellen kunne ikkje kontrollerast. Prøv igjen.');
  }
  try { await cache?.put(asset.url, new Response(bytes)); } catch { /* Limited storage must not prevent inference. */ }
  onProgress(100);
  return bytes;
}
