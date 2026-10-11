// Run the exact browser worker inside a Node worker, supplying only browser messaging
// and local copies of its public network assets. Inference is real, single-thread WASM.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';

globalThis.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };
globalThis.fetch = async input => {
  const url = String(input);
  if (url.endsWith('/models/manifest.json')) return new Response(JSON.stringify(workerData.manifest));
  const filename = url === workerData.manifest.asset.url ? 'model.onnx'
    : url === workerData.manifest.runtime.url ? 'runtime.wasm' : null;
  if (!filename) throw new Error('Unexpected fetch: ' + url);
  return new Response(await readFile(new URL('../.pointcloud-cache/' + filename, import.meta.url)));
};
await import('../static/pointcloud/depth-worker.mjs');
parentPort.on('message', data => void self.onmessage({ data }));
parentPort.postMessage({ type: 'ready' });
