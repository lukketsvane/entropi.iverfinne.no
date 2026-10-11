// Bridge browser messaging only; execute the exact production panorama worker.
import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:(message,transfer)=>parentPort.postMessage(message,transfer)};
await import('../static/pointcloud/panorama-worker.mjs');
parentPort.on('message',data=>self.onmessage({data}));
parentPort.postMessage({type:'ready'});
