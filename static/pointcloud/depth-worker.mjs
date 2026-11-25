import { normalizedImage, fitSize } from './math.mjs';
import { loadAsset } from './assets.mjs';
import { resizePixels } from './tiles.mjs';

const CACHE = 'entropi-depth-v2';
let enginePromise = null;
let running = false;

const progress = (id, phase, percent) => self.postMessage({ id, type: 'progress', phase, percent });

async function readManifest() {
  const response = await fetch(new URL('./models/manifest.json', import.meta.url), { cache: 'no-cache' });
  if (!response.ok) throw new Error('Kunne ikkje hente djupnemodellen.');
  return response.json();
}

async function openCache() {
  try {
    for (const name of await caches.keys()) if (name.startsWith('entropi-depth-') && name !== CACHE) await caches.delete(name);
    return await caches.open(CACHE);
  } catch { return null; }
}

/** Load files in order with one combined progress value. */
async function loadAll(assets, id, phase, cache) {
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const files = [];
  let done = 0;
  for (const asset of assets) {
    files.push(await loadAsset(asset, percent => progress(id, phase, Math.round((done + asset.bytes * percent / 100) / total * 100)), fetch, cache));
    done += asset.bytes;
  }
  return files;
}

function configure(ort) {
  ort.env.wasm.numThreads = 1; // Safari: no SharedArrayBuffer or cross-origin isolation required.
  ort.env.wasm.proxy = false; // This module already runs in a worker.
  ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
  ort.env.logLevel = 'error';
}

// The larger model at higher resolution, where the browser offers WebGPU.
async function gpuEngine(manifest, id, cache) {
  const spec = manifest.webgpu;
  // The manifest can switch the GPU model off without a new release.
  if (!spec || spec.enabled !== true || !(await self.navigator?.gpu?.requestAdapter?.().catch(() => null))) return null;
  const ort = await import('./vendor/ort.webgpu.min.mjs');
  configure(ort);
  const [runtime, graph, ...parts] = await loadAll([spec.runtime, spec.graph, ...spec.data], id, 'loading-model', cache);
  ort.env.wasm.wasmBinary = runtime;
  progress(id, 'starting');
  const session = await ort.InferenceSession.create(graph, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all',
    externalData: spec.data.map((part, index) => ({ path: part.name, data: parts[index] })) });
  return { ort, session, max: spec.max, area: spec.pixels ?? Infinity, model: spec.model, gpu: true };
}

async function cpuEngine(manifest, id, cache) {
  const ort = await import('./vendor/ort.wasm.min.mjs');
  configure(ort);
  const [runtime, model] = await loadAll([manifest.runtime, manifest.asset], id, 'loading-model', cache);
  ort.env.wasm.wasmBinary = runtime;
  progress(id, 'starting');
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return { ort, session, max: manifest.max, model: manifest.model, gpu: false };
}

const gpuError = error => Object.assign(error instanceof Error ? error : new Error('GPU-feil.'), { gpu: true });

function engine(id, cpuOnly = false) {
  if (!enginePromise) enginePromise = (async () => {
    const [manifest, cache] = await Promise.all([readManifest(), openCache()]);
    if (!cpuOnly) {
      // A failed GPU start is retried by a fresh CPU-only worker; two runtimes in one worker exhaust iOS memory.
      try { const gpu = await gpuEngine(manifest, id, cache); if (gpu) return gpu; } catch (error) { throw gpuError(error); }
    }
    return cpuEngine(manifest, id, cache);
  })().catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

async function infer(current, rgba, width, height) {
  const size = fitSize(width, height, current.max, current.area);
  const input = size.width === width && size.height === height ? rgba : resizePixels({ data: rgba, width, height }, size.width, size.height).data;
  const tensor = new current.ort.Tensor('float32', normalizedImage(input, size.width, size.height), [1, 3, size.height, size.width]);
  let outputs;
  try {
    outputs = await current.session.run({ [current.session.inputNames[0]]: tensor });
    const output = outputs[current.session.outputNames[0]], dims = output.dims;
    const depth = new Float32Array(await output.getData());
    if (depth.length !== dims.at(-1) * dims.at(-2)) throw new Error('Uventa djupnekart.');
    return { depth, width: dims.at(-1), height: dims.at(-2) };
  } finally {
    tensor.dispose();
    for (const output of Object.values(outputs || {})) output.dispose();
  }
}

self.onmessage = async event => {
  const { id, width, height, rgba, gpuLimit = Infinity } = event.data;
  if (running) { self.postMessage({ id, type: 'error', message: 'Djupneberekninga er oppteken.' }); return; }
  running = true;
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || width > 1536 || height > 1536 || width % 32 || height % 32) throw new Error('Ugyldig storleik for djupnemodellen.');
    const pixels = new Uint8ClampedArray(rgba);
    const current = await engine(id, gpuLimit <= 0);
    const max = current.gpu ? Math.min(current.max, gpuLimit) : current.max;
    progress(id, 'estimating');
    let result;
    try { result = await infer({ ...current, max }, pixels, width, height); }
    catch (error) { throw current.gpu ? gpuError(error) : error; }
    self.postMessage({ id, type: 'result', depth: result.depth.buffer, width: result.width, height: result.height, model: current.model }, [result.depth.buffer]);
  } catch (error) {
    self.postMessage({ id, type: 'error', gpu: error?.gpu === true, message: error?.message || 'Kunne ikkje berekne djupna.' });
  } finally {
    running = false;
  }
};
