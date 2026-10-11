import { env, InferenceSession, Tensor } from './vendor/ort.wasm.min.mjs';
import { normalizedImage } from './math.mjs';
import { loadAsset } from './assets.mjs';

env.wasm.numThreads = 1; // Safari: no SharedArrayBuffer or cross-origin isolation required.
env.wasm.proxy = false; // This module already runs in a worker.
env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
env.logLevel = 'error';
let sessionPromise = null;
let running = false;

const progress = (id, phase, percent) => self.postMessage({ id, type: 'progress', phase, percent });
async function modelBytes(id) {
  const response = await fetch(new URL('./models/manifest.json', import.meta.url), { cache: 'force-cache' });
  if (!response.ok) throw new Error('Kunne ikkje hente djupnemodellen.');
  const manifest = await response.json();
  let cache = null;
  try { cache = await caches.open('entropi-depth-v1-' + manifest.asset.sha256.slice(0, 12)); } catch { }
  const model = await loadAsset(manifest.asset, percent => progress(id, 'loading-model', percent), fetch, cache);
  env.wasm.wasmBinary = await loadAsset(manifest.runtime, percent => progress(id, 'loading-runtime', percent), fetch, cache);
  return model;
}

function getSession(id) {
  if (!sessionPromise) sessionPromise = (async () => {
    const bytes = await modelBytes(id);
    progress(id, 'starting');
    return InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch(error => { sessionPromise = null; throw error; });
  return sessionPromise;
}

self.onmessage = async event => {
  const { id, width, height, rgba } = event.data;
  if (running) { self.postMessage({ id, type: 'error', message: 'Djupneberekninga er oppteken.' }); return; }
  running = true;
  let input, outputs;
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 14 || height < 14 || width > 420 || height > 420 || width % 14 || height % 14) throw new Error('Ugyldig storleik for djupnemodellen.');
    const pixels = normalizedImage(new Uint8ClampedArray(rgba), width, height);
    const session = await getSession(id);
    input = new Tensor('float32', pixels, [1, 3, height, width]);
    progress(id, 'estimating');
    outputs = await session.run({ [session.inputNames[0]]: input });
    const output = outputs[session.outputNames[0]], dims = output.dims;
    const depthWidth = dims.at(-1), depthHeight = dims.at(-2);
    const depth = new Float32Array(output.data);
    if (depth.length !== depthWidth * depthHeight) throw new Error('Uventa djupnekart.');
    self.postMessage({ id, type: 'result', depth: depth.buffer, width: depthWidth, height: depthHeight }, [depth.buffer]);
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error?.message || 'Kunne ikkje berekne djupna.' });
  } finally {
    input?.dispose();
    for (const output of Object.values(outputs || {})) output.dispose();
    running = false;
  }
};
