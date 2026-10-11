export const MAX_FRAMES = 8;
export const MAX_UPLOAD = 4_000_000;
export const ARTIFACT_CHUNK = 2_000_000;
export const MAX_ARTIFACT = 64_000_000;
const JOB_ID = /^[a-zA-Z0-9_-]{8,128}$/;
/** @typedef {{data:Uint8ClampedArray,width:number,height:number}} Pixels */
/** @typedef {{percent?:number,phase:string}} Progress */

/** Keep independent viewpoints, including both ends of a pan, within the phone's upload budget.
 * @param {Pixels[]} frames */
export function reconstructionFrames(frames) {
  /** @type {Pixels[]} */ const distinct = [];
  for (const frame of frames) {
    const previous = distinct.at(-1);
    let changed = !previous || frame.width !== previous.width || frame.height !== previous.height;
    if (!changed && previous) {
      let difference = 0;
      for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
        const at = (Math.floor((y + .5) * frame.height / 12) * frame.width + Math.floor((x + .5) * frame.width / 12)) * 4;
        for (let c = 0; c < 3; c++) difference += Math.abs(frame.data[at + c] - previous.data[at + c]);
      }
      changed = difference / (12 * 12 * 3) > 2;
    }
    if (changed) distinct.push(frame);
  }
  if (distinct.length <= MAX_FRAMES) return distinct;
  return Array.from({length: MAX_FRAMES}, (_, i) => distinct[Math.round(i * (distinct.length - 1) / (MAX_FRAMES - 1))]);
}

/** @param {Pixels} frame @param {number} quality */
async function jpeg(frame, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width; canvas.height = frame.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Kunne ikkje lese kamerabiletet.');
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  /** @type {Blob} */ const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('Kunne ikkje klargjere biletet.')), 'image/jpeg', quality);
  });
  canvas.width = canvas.height = 1;
  return blob;
}

/** Download bounded responses: a Gaussian artifact is larger than Vercel's buffered response limit.
 * @param {string} id @param {number} size @param {string} hash @param {AbortSignal} signal
 * @param {typeof fetch} request */
export async function downloadSplats(id, size, hash, signal, request = fetch) {
  if (!JOB_ID.test(id) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT || size % 32 !== 0) {
    throw new Error('Modelltenaren gav ei ugyldig Gaussian-fil.');
  }
  const bytes = new Uint8Array(size);
  for (let start = 0; start < size; start += ARTIFACT_CHUNK) {
    const end = Math.min(size - 1, start + ARTIFACT_CHUNK - 1);
    const response = await request(`/api/reconstruct/jobs/${id}/artifact`, {
      headers: {Range: `bytes=${start}-${end}`}, signal, cache: 'no-store'
    });
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${size}`) {
      throw new Error('Gaussian-fila vart ikkje overført fullstendig.');
    }
    const part = new Uint8Array(await response.arrayBuffer());
    if (part.length !== end - start + 1) throw new Error('Gaussian-fila er ufullstendig.');
    bytes.set(part, start);
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Kontrollsummen for Gaussian-fila manglar.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, x => x.toString(16).padStart(2, '0')).join('') !== hash) {
    throw new Error('Gaussian-fila vart skadd under overføringa.');
  }
  return bytes;
}

/** Actual 3DGS inference runs on Shadow; the browser only captures, uploads and renders.
 * @param {Pixels[]} frames @param {(update:Progress)=>void} update @param {AbortSignal} signal */
export async function reconstructGaussian(frames, update, signal) {
  signal.throwIfAborted();
  const available = await fetch('/api/reconstruct/health', { signal, cache: 'no-store' });
  const health = await available.json();
  if (!available.ok || health.representation !== 'gaussian-splats' || !health.ready) {
    throw new Error('Gaussian-tenaren er utilgjengeleg. Brukar lokal djupne som reserve.');
  }
  const selected = reconstructionFrames(frames);
  if (!selected.length) throw new Error('Kamerabileta manglar.');
  let images = await Promise.all(selected.map(frame => jpeg(frame, .86)));
  if (images.reduce((sum, blob) => sum + blob.size, 0) > MAX_UPLOAD) images = await Promise.all(selected.map(frame => jpeg(frame, .55)));
  if (images.reduce((sum, blob) => sum + blob.size, 0) > MAX_UPLOAD) throw new Error('Kamerabileta er for store.');
  const form = new FormData();
  images.forEach((blob, i) => form.append('images', blob, `view-${i.toString().padStart(2, '0')}.jpg`));
  update({phase: 'uploading', percent: 5});
  const created = await fetch('/api/reconstruct/jobs', {method: 'POST', body: form, signal});
  const job = await created.json();
  if (!created.ok || typeof job.id !== 'string' || !JOB_ID.test(job.id)) throw new Error(job.error || 'Modelltenaren kunne ikkje starte.');
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const response = await fetch(`/api/reconstruct/jobs/${job.id}`, {signal, cache: 'no-store'});
    const status = await response.json();
    if (!response.ok || status.status === 'failed') throw new Error(status.error || 'Gaussian-modellen stoppa.');
    update({phase: 'reconstructing', percent: Math.max(5, Math.min(90, Number(status.progress) || 5))});
    if (status.status === 'succeeded') {
      if (status.representation !== 'gaussian-splats') throw new Error('Tenaren returnerte ei punktsky utan Gaussian-parametrar.');
      const bytes = await downloadSplats(job.id, status.sizeBytes, status.sha256, signal);
      update({phase: 'rendering', percent: 95});
      return {bytes, model: String(status.model), camera: status.camera, frames: selected.length};
    }
    await new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(undefined); }, 900);
      signal.addEventListener('abort', aborted, {once: true});
      if (signal.aborted) aborted();
    });
  }
  throw new Error('Gaussian-modellen brukte for lang tid.');
}
