import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateTranslation, registerFrames, stitchPanorama} from '../static/pointcloud/panorama.mjs';
import {depthTiles, mergeDepthTile, estimateImageDepth} from '../static/pointcloud/tiles.mjs';
import {FrameRecorder} from '../src/lib/pointcloud/recorder.mjs';
import {imageToPointCloud} from '../static/pointcloud/math.mjs';

function view(offsetX=0,offsetY=0,width=160,height=120) {
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const px=x+offsetX,py=y+offsetY,i=(y*width+x)*4;
    const a=Math.sin(px*.19+Math.cos(py*.17)*3),b=Math.cos(py*.23+Math.sin(px*.11)*2);
    data[i]=110+70*a;data[i+1]=100+65*b;data[i+2]=100+50*Math.sin(px*.13+py*.21);data[i+3]=255;
  }
  return {data,width,height};
}
test('registered pan follows real overlapping image features, including vertical movement',()=>{
  const a=view(),b=view(25,5),c=view(50,10);
  const move=estimateTranslation(a,b);
  assert.ok(move&&move.confidence>.72);assert.ok(Math.abs(move.x+25)<2);assert.ok(Math.abs(move.y+5)<2);
  const placements=registerFrames([a,b,c]);assert.equal(placements.length,3);
  assert.ok(Math.abs(placements[2].x-50)<3);assert.ok(Math.abs(placements[2].y-10)<3);
  const panorama=stitchPanorama([a,b,c]);
  assert.equal(panorama.inputFrames,3);assert.equal(panorama.registeredFrames,3);
  assert.ok(panorama.width>200);assert.ok(panorama.height>125);assert.equal(panorama.horizontal,true);
  assert.equal(panorama.data[3],255);
  assert.ok(panorama.data[(panorama.width-1)*4+3]===0,'unphotographed corners remain transparent');
});
test('duplicate, blank and unrelated views are not arranged into a fake panorama',()=>{
  const a=view(), blank={data:new Uint8ClampedArray(a.data.length).fill(255),width:a.width,height:a.height};
  assert.equal(estimateTranslation(blank,blank),null);
  assert.equal(registerFrames([a,a,blank]).length,1);
  const panorama=stitchPanorama([a,blank]);
  assert.equal(panorama.registeredFrames,1);assert.equal(panorama.width,a.width);
  assert.deepEqual(panorama.data,a.data);
  assert.throws(()=>stitchPanorama([]),/Ingen/);
});
test('panorama geometry uses the original camera focal estimate and excludes empty coverage',()=>{
  const rgba=new Uint8ClampedArray([255,255,255,255,0,0,0,0,200,200,200,255,255,255,255,255]);
  const cloud=imageToPointCloud({rgba,width:2,height:2,depth:new Float32Array([1,2,3,4]),depthWidth:2,depthHeight:2,stride:1,focalEstimate:3});
  assert.equal(cloud.count,3);assert.equal(cloud.focalEstimate,3);assert.ok(cloud.positions.every(Number.isFinite));
});
test('overlapping tiles cover both panorama directions and align affine relative depth',()=>{
  for(const [width,height]of [[240,80],[80,240]]) {
    const tiles=depthTiles(width,height),coverage=new Uint8Array(width*height);
    for(const t of tiles)for(let y=t.y;y<t.y+t.height;y++)for(let x=t.x;x<t.x+t.width;x++)coverage[y*width+x]++;
    assert.ok(coverage.every(n=>n>0));assert.ok(coverage.some(n=>n>1));
  }
  const width=120,height=80,sums=new Float32Array(width*height),weights=new Float32Array(sums.length);
  const first={x:0,y:0,width:80,height:80},second={x:40,y:0,width:80,height:80};
  const truth=(x,y)=>x*.04+y*.02+2;
  const p1=Float32Array.from({length:6400},(_,i)=>truth(i%80,Math.floor(i/80)));
  const p2=Float32Array.from({length:6400},(_,i)=>(truth(i%80+40,Math.floor(i/80))-3)/2);
  mergeDepthTile(sums,weights,width,first,p1);mergeDepthTile(sums,weights,width,second,p2);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)assert.ok(Math.abs(sums[y*width+x]/weights[y*width+x]-truth(x,y))<1e-4);
});
test('wide photo depth retains multiple model views and cancels before subsequent tiles',async()=>{
  const pixels=view(0,0,240,80);let calls=0,current=true;
  const estimator={async estimate(_rgba,width,height){calls++;return {depth:new Float32Array(width*height).fill(4),width,height};}};
  const result=await estimateImageDepth(pixels,estimator,()=>{});
  assert.ok(calls>1);assert.equal(result.width/result.height,3);assert.ok(result.depth.every(n=>Math.abs(n-4)<1e-5));
  calls=0;await assert.rejects(estimateImageDepth(pixels,estimator,()=>{current=false;},()=>current),{name:'AbortError'});
  assert.equal(calls,1);
});
test('a short tap captures once; holding collects later frames up to a bounded memory limit',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let time=0,sequence=0,holds=0;const results=[];
  const recorder=new FrameRecorder({capture:()=>({...view(),sequence:sequence++}),onHold:()=>holds++,finish:frames=>results.push(frames),now:()=>time,limit:5});
  recorder.begin();time=100;recorder.end();assert.equal(results[0].length,1);assert.equal(holds,0);
  recorder.begin();time=420;t.mock.timers.tick(320);assert.equal(holds,1);
  for(let i=0;i<8;i++){time+=250;t.mock.timers.tick(250);}recorder.end();
  assert.equal(results[1].length,5);assert.equal(new Set(results[1].map(f=>f.sequence)).size,5);
  t.mock.timers.tick(1000);assert.equal(results.length,2);
});
test('pointer cancellation discards the recording and never processes abandoned frames',t=>{
  t.mock.timers.enable({apis:['setTimeout']});let finishes=0,cancels=0;
  const recorder=new FrameRecorder({capture:()=>view(),onHold:()=>{},finish:()=>finishes++,cancel:()=>cancels++});
  recorder.begin();t.mock.timers.tick(600);recorder.abort();recorder.end();t.mock.timers.tick(1000);
  assert.equal(finishes,0);assert.equal(cancels,1);assert.equal(recorder.frames.length,0);
});
