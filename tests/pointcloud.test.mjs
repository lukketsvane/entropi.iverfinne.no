import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedImage, imageToPointCloud, pointCloudPLY, inferenceSize, pointStride } from '../static/pointcloud/math.mjs';
import { DepthEstimator } from '../src/lib/pointcloud/estimator.mjs';
import { loadAsset } from '../static/pointcloud/assets.mjs';
import { createHash } from 'node:crypto';

const photo = (size, color = [200,80,40,255]) => new Uint8ClampedArray(Array.from({length:size}, () => color).flat());
const depth = Float32Array.from([1,1,2,2, 1,1,2,2, 3,3,4,4, 3,3,4,4]);
function makeCloud(rgba = photo(16), values = depth) {
  return imageToPointCloud({rgba,width:4,height:4,depth:values,depthWidth:4,depthHeight:4,stride:1});
}

test('portrait, landscape and square captures keep their aspect and fit the mobile point budget', () => {
  for (const [width,height] of [[630,840],[840,630],[840,840],[840,200]]) {
    const size = inferenceSize(width,height);
    assert.equal(size.width%14,0); assert.equal(size.height%14,0);
    assert.equal(Math.max(size.width,size.height),420);
    if (width !== height) assert.equal(size.width>size.height,width>height);
    const stride = pointStride(width,height);
    assert.ok(Math.ceil(width/stride)*Math.ceil(height/stride)<=42000);
  }
});

const bytes = new Uint8Array([0,1,2,3,4,5]);
const asset = {url:'https://model.test/pinned-model',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
test('model downloads validate their bytes before caching and work without available cache storage', async () => {
  let saved = false;
  const cache = {match:async()=>null,put:async(_url,response)=>{saved=true;assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);},delete:async()=>{}};
  const progress=[];
  assert.deepEqual(await loadAsset(asset,n=>progress.push(n),async()=>new Response(bytes),cache),bytes);
  assert.equal(saved,true);assert.equal(progress.at(-1),100);
  cache.put=async()=>{throw new Error('quota');};
  assert.deepEqual(await loadAsset(asset,()=>{},async()=>new Response(bytes),cache),bytes);
});

test('cached weights avoid another network download and corrupt caches are removed', async () => {
  let deleted=false;
  const cache={match:async()=>new Response(bytes),put:async()=>{},delete:async()=>{deleted=true;}};
  const noNetwork=async()=>{throw new Error('offline');};
  assert.deepEqual(await loadAsset(asset,()=>{},noNetwork,cache),bytes);
  cache.match=async()=>new Response(new Uint8Array(bytes.length));
  await assert.rejects(loadAsset(asset,()=>{},noNetwork,cache),/kontrollerast/);
  assert.equal(deleted,true);
  await assert.rejects(loadAsset(asset,()=>{},async()=>new Response(bytes.slice(0,3))),/kontrollerast/);
});

test('model input uses the pinned ImageNet RGB normalization and planar channel order', () => {
  const data = normalizedImage(new Uint8ClampedArray([255,0,0,255, 0,0,0,0]),2,1);
  const expected = [(1-.485)/.229,(1-.485)/.229, (0-.456)/.224,(1-.456)/.224, (0-.406)/.225,(1-.406)/.225];
  for(let i=0;i<data.length;i++) assert.ok(Math.abs(data[i]-expected[i])<1e-6);
});

test('coloured points have genuine depth coordinates independent of image brightness', () => {
  const first = makeCloud(), dark = makeCloud(photo(16,[0,0,0,255]));
  assert.deepEqual(first.positions,dark.positions);
  assert.notDeepEqual(first.colors,dark.colors);
  const z = Array.from({length:first.count},(_,i)=>first.positions[i*3+2]);
  assert.ok(Math.max(...z)-Math.min(...z)>.5);
  assert.ok(first.positions.every(Number.isFinite));
  assert.deepEqual([...first.colors.slice(0,3)],[200,80,40]);
  assert.equal(first.units,'relative'); assert.equal(first.estimated,true);
});

test('constant model depth remains a flat finite surface rather than fabricated relief', () => {
  const cloud = makeCloud(photo(16),new Float32Array(16).fill(8));
  assert.ok(cloud.positions.every(Number.isFinite));
  for(let i=0;i<cloud.count;i++) assert.ok(Math.abs(cloud.positions[i*3+2])<1e-6);
  assert.ok(cloud.positions[0]<0 && cloud.positions[3*3]>0);
  assert.ok(cloud.positions[1]>0 && cloud.positions[12*3+1]<0);
});

test('depth is resampled to the photo and point budget is bounded by stride', () => {
  const cloud=imageToPointCloud({rgba:photo(35),width:5,height:7,depth:new Float32Array([1,2,3,4]),depthWidth:2,depthHeight:2,stride:2});
  assert.equal(cloud.count,12); assert.equal(cloud.positions.length,36);
  assert.ok(cloud.positions.every(Number.isFinite));
});

test('invalid or missing depth is rejected instead of substituting pixel brightness', () => {
  assert.throws(()=>makeCloud(photo(15)),/kamerabilete/);
  assert.throws(()=>makeCloud(photo(16),new Float32Array(16).fill(NaN)),/ugyldige/);
  assert.throws(()=>imageToPointCloud({rgba:photo(16),width:4,height:4,depth:null,depthWidth:0,depthHeight:0}),/djupnekart/);
});

test('PLY exports every XYZ coordinate and original RGB in binary little endian', () => {
  const cloud=makeCloud(), bytes=pointCloudPLY(cloud);
  const text=new TextDecoder().decode(bytes), end=text.indexOf('end_header\n')+'end_header\n'.length;
  assert.ok(text.includes('element vertex 16\n'));
  assert.ok(text.includes('relative units'));
  assert.equal(bytes.length,end+cloud.count*15);
  const data=new DataView(bytes.buffer);
  for(let c=0;c<3;c++)assert.equal(data.getFloat32(end+c*4,true),cloud.positions[c]);
  assert.deepEqual([...bytes.slice(end+12,end+15)],[200,80,40]);
});

class FakeWorker {
  constructor(){this.messages=[];this.terminated=false;}
  postMessage(data){this.messages.push(data);}
  respond(data){this.onmessage({data});}
  terminate(){this.terminated=true;}
}
test('depth worker requests preserve colour pixels and ignore stale results', async()=>{
  const worker=new FakeWorker(), estimator=new DepthEstimator(()=>worker), input=photo(4), events=[];
  const pending=estimator.estimate(input,2,2,event=>events.push(event.phase));
  const id=worker.messages[0].id;
  assert.notEqual(worker.messages[0].rgba,input.buffer);
  assert.equal(input.byteLength,16);
  await assert.rejects(estimator.estimate(input,2,2),/oppteken/);
  worker.respond({id:id-1,type:'result',depth:new Float32Array([99]).buffer,width:1,height:1});
  assert.ok(estimator.pending);
  worker.respond({id,type:'progress',phase:'estimating'});
  worker.respond({id,type:'result',depth:new Float32Array([1,2,3,4]).buffer,width:2,height:2});
  const result=await pending;
  assert.deepEqual([...result.depth],[1,2,3,4]);assert.deepEqual(events,['estimating']);
  estimator.dispose();assert.equal(worker.terminated,true);
});

test('failed and cancelled inference rejects and can start a fresh worker', async()=>{
  const workers=[], estimator=new DepthEstimator(()=>{const worker=new FakeWorker();workers.push(worker);return worker;});
  const first=estimator.estimate(photo(4),2,2);
  const error=assert.rejects(first,/no model/);
  workers[0].respond({id:workers[0].messages[0].id,type:'error',message:'no model'}); await error;
  assert.equal(workers[0].terminated,true);
  const second=estimator.estimate(photo(4),2,2);
  const cancelled=assert.rejects(second,err=>err.name==='AbortError');
  estimator.dispose();await cancelled;
  assert.equal(workers.length,2);assert.equal(workers[1].terminated,true);
});
