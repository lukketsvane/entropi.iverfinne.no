const MAX_UPLOAD = 4_000_000;
const CHUNK = 2_000_000;
const MAX_ARTIFACT = 96_000_000;
const ID = /^[a-zA-Z0-9_-]{8,128}$/;
const noStore = {'Cache-Control': 'no-store'};
/** @param {string} error @param {number} status */
const failure = (error, status) => Response.json({error}, {status, headers: noStore});

/** @param {{request?:typeof fetch,env?:Record<string,string|undefined>}} [options] */
export function reconstructionProxy({request = fetch, env = process.env} = {}) {
  const base = env.GAUSS_BACKEND_URL || env.TRIPOSPLAT_BACKEND_URL;
  const token = env.GAUSS_BACKEND_TOKEN || env.TRIPOSPLAT_BACKEND_TOKEN;
  /** @param {string} path @param {RequestInit} [init] @param {number} [timeout] */
  async function upstream(path, init = {}, timeout = 15_000) {
    if (!base || !token) throw new Error('Modelltenaren er ikkje konfigurert.');
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
    const deadline = AbortSignal.timeout(timeout);
    return request(new URL(path, base), {...init, headers, cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline});
  }
  return {
    async health() {
      try {
        const response = await upstream('/api/reconstruct/health', {}, 2000);
        const data = await response.json();
        if (!response.ok || data.representation !== 'gaussian-splats' || data.ready !== true) {
          return failure('Gaussian-tenaren er ikkje klar.', 503);
        }
        return Response.json({ready: true, representation: data.representation, models: data.models}, {headers: noStore});
      } catch { return failure('Gaussian-tenaren er utilgjengeleg.', 503); }
    },
    /** @param {Request} incoming */
    async create(incoming) {
      const origin = incoming.headers.get('origin');
      if (origin && origin !== new URL(incoming.url).origin) return failure('Ugyldig opphav.', 403);
      if (Number(incoming.headers.get('content-length')) > MAX_UPLOAD + 32_768) return failure('Kamerabileta er for store.', 413);
      let images;
      try { images = (await incoming.formData()).getAll('images'); }
      catch { return failure('Kunne ikkje lese kamerabileta.', 400); }
      if (!images.length || images.length > 8 || images.some(file => !(file instanceof File) || !['image/jpeg','image/png','image/webp'].includes(file.type) || !file.size)) {
        return failure('Send eitt til åtte kamerabilete.', 400);
      }
      const files = /** @type {File[]} */ (images);
      if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD) return failure('Kamerabileta er for store.', 413);
      const form = new FormData(); files.forEach((file, i) => form.append('images', file, `view-${i}.jpg`));
      try {
        const response = await upstream('/api/reconstruct/jobs', {method: 'POST', body: form, signal: incoming.signal}, 45_000);
        const data = await response.json();
        if (!response.ok) return failure('Gaussian-tenaren kunne ikkje starte.', response.status === 429 ? 429 : 502);
        if (typeof data.id !== 'string' || !ID.test(data.id)) return failure('Modelltenaren gav ein ugyldig jobb.', 502);
        return Response.json({id: data.id, status: 'queued'}, {status: 202, headers: noStore});
      } catch { return failure('Gaussian-tenaren er utilgjengeleg.', 502); }
    },
    /** @param {string} id @param {Request} incoming */
    async status(id, incoming) {
      if (!ID.test(id)) return failure('Ugyldig jobb.', 400);
      try {
        const response = await upstream(`/api/reconstruct/jobs/${id}`, {signal: incoming.signal});
        const data = await response.json();
        if (!response.ok) return failure('Gaussian-jobben er utilgjengeleg.', response.status === 404 ? 404 : 502);
        return Response.json({status: data.status, progress: data.progress, representation: data.representation,
          model: data.model, sizeBytes: data.sizeBytes, sha256: data.sha256, camera: data.camera,
          error: data.status === 'failed' ? 'Gaussian-modellen stoppa.' : undefined}, {headers: noStore});
      } catch { return failure('Gaussian-tenaren er utilgjengeleg.', 502); }
    },
    /** @param {string} id @param {Request} incoming */
    async artifact(id, incoming) {
      if (!ID.test(id)) return failure('Ugyldig jobb.', 400);
      const range = incoming.headers.get('range') || '';
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return failure('Ei avgrensa byteoverføring er påkravd.', 416);
      const start = Number(match[1]), end = Number(match[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > CHUNK || end >= MAX_ARTIFACT) {
        return failure('Ugyldig byteområde.', 416);
      }
      try {
        const response = await upstream(`/api/reconstruct/jobs/${id}/artifact`, {headers: {Range: range}, signal: incoming.signal}, 45_000);
        const expected = end - start + 1;
        const returnedRange = response.headers.get('content-range');
        const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(returnedRange || '');
        if (response.status !== 206 || Number(response.headers.get('content-length')) !== expected || !rangeMatch
          || Number(rangeMatch[1]) !== start || Number(rangeMatch[2]) !== end || Number(rangeMatch[3]) > MAX_ARTIFACT) {
          await response.body?.cancel(); return failure('Gaussian-fila vart ikkje overført fullstendig.', 502);
        }
        // Never buffer an unlimited upstream response even if it lies about Content-Length.
        const reader = response.body?.getReader();
        if (!reader) return failure('Gaussian-fila manglar.', 502);
        const bytes = new Uint8Array(expected); let offset = 0;
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          if (offset + value.length > expected) { await reader.cancel(); return failure('Gaussian-fila er for stor.', 502); }
          bytes.set(value, offset); offset += value.length;
        }
        if (offset !== expected) return failure('Gaussian-fila er ufullstendig.', 502);
        return new Response(bytes, {status: 206, headers: {...noStore, 'Content-Type': 'application/octet-stream',
          'Content-Length': String(expected), 'Content-Range': returnedRange || '', 'Accept-Ranges': 'bytes'}});
      } catch { return failure('Gaussian-fila er utilgjengeleg.', 502); }
    }
  };
}
