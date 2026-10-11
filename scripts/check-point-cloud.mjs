import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { imageToPointCloud, pointCloudPLY, inferenceSize, pointStride } from '../static/pointcloud/math.mjs';

const manifest = JSON.parse(await readFile(new URL('../static/pointcloud/models/manifest.json', import.meta.url)));
const worker = new Worker(new URL('./point-cloud-worker-check.mjs', import.meta.url), { workerData: { manifest } });
let sequence = 0;
function request(message) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const onMessage = result => {
      if (result.id !== id || result.type === 'progress') return;
      worker.off('message', onMessage);
      result.type === 'error' ? reject(new Error(result.message)) : resolve(result);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
    worker.postMessage({ ...message, id });
  });
}
function photo(width,height) {
  const data = new Uint8ClampedArray(width*height*4);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const foreground = Math.hypot(x-width/2,y-height/2)<width/3;
    data.set(foreground ? [220,95,40,255] : [30+Math.round(x/width*100),90,Math.round(y/height*255),255],(y*width+x)*4);
  }
  return data;
}
const started = performance.now();
try {
  await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
  const results=[];
  for (const [width,height] of [[630,840],[840,630],[840,840]]) {
    const size = inferenceSize(width,height);
    const input = photo(size.width,size.height);
    const result = await request({rgba:input.buffer,width:size.width,height:size.height});
    assert.deepEqual([result.width,result.height],[size.width,size.height]);
    const depth = new Float32Array(result.depth);
    assert.ok(depth.every(Number.isFinite));
    let min=Infinity,max=-Infinity;
    for (const value of depth) {min=Math.min(min,value);max=Math.max(max,value);}
    assert.ok(max-min>.01,'Inference must give non-flat relative depth');
    const rgba=photo(width,height);
    const cloud=imageToPointCloud({rgba,width,height,depth,depthWidth:size.width,depthHeight:size.height,stride:pointStride(width,height)});
    assert.ok(cloud.count<=42000);
    assert.ok(cloud.positions.every(Number.isFinite));
    const ply=pointCloudPLY(cloud);
    assert.ok(new TextDecoder().decode(ply.slice(0,260)).includes('relative units'));
    results.push({capture:[width,height],inference:[size.width,size.height],depthRange:[min,max],points:cloud.count,plyBytes:ply.length});
  }
  await assert.rejects(request({rgba:new ArrayBuffer(16),width:2,height:2}),/storleik/);
  console.log(JSON.stringify({runtime:'Actual browser worker, single-thread WASM',modelSHA256:manifest.asset.sha256,captures:results,seconds:Math.round((performance.now()-started)/10)/100}));
} finally { await worker.terminate(); }
