import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';

const source=ts.transpileModule(fs.readFileSync('src/lib/pointcloud/head-tracker.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
function fixture(request,bitmap=async()=>({close(){}})) {
  const poses=[],states=[],errors=[],frames=new Map(),workers=[];
  let now=1000,stops=0,frameId=0;
  class WorkerMock {
    constructor(url){assert.equal(url,'/pointcloud/vision/head-worker.js?v=1');workers.push(this);}
    postMessage(data){if(data.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}
    terminate(){this.terminated=true;}
  }
  const track={stop(){stops++;},addEventListener(){},removeEventListener(){}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const video={readyState:2,currentTime:1,srcObject:null,play:async()=>{},pause(){},addEventListener(){},removeEventListener(){}};
  const exports={};
  vm.runInNewContext(source,{
    exports,performance:{now:()=>now},document:{hidden:false},
    navigator:{mediaDevices:{getUserMedia:request??(async constraints=>{
      assert.equal(constraints.audio,false);assert.equal(constraints.video.facingMode,'user');return stream;
    })}},
    window:{isSecureContext:true,Worker:WorkerMock,createImageBitmap:bitmap,setTimeout,clearTimeout,addEventListener(){},removeEventListener(){}},
    Worker:WorkerMock,createImageBitmap:bitmap,
    requestAnimationFrame:cb=>{frames.set(++frameId,cb);return frameId;},cancelAnimationFrame:id=>frames.delete(id)
  });
  const tracker=new exports.HeadTracker(video,{pose:p=>poses.push(p),state:s=>states.push(s),error:e=>errors.push(e)});
  return {tracker,video,stream,workers,poses,states,errors,stops:()=>stops,clock:value=>now=value};
}

test('front camera calibrates, mirrors movement, loses the face and releases all resources',async()=>{
  const active=fixture();await active.tracker.start();
  assert.equal(active.video.srcObject,active.stream);assert.equal(active.video.playsInline,true);
  for(let i=0;i<7;i++)active.workers[0].onmessage({data:{type:'face',face:{x:.5,y:.5,size:.3}}});
  assert.equal(active.states.at(-1),'tracking');
  active.workers[0].onmessage({data:{type:'face',face:{x:.4,y:.55,size:.4}}});
  assert.ok(active.poses.at(-1).x>0&&active.poses.at(-1).y<0&&active.poses.at(-1).z<0);
  active.clock(1700);active.tracker.tick(1700);
  assert.equal(active.states.at(-1),'searching');assert.equal(active.poses.at(-1),null);
  active.tracker.recenter();assert.equal(active.states.at(-1),'calibrating');
  active.tracker.stop();active.tracker.stop();
  assert.equal(active.stops(),1);assert.equal(active.video.srcObject,null);assert.equal(active.workers[0].terminated,true);
});

test('denied camera and permission returned after cancellation leave no active video',async()=>{
  const denied=fixture(async()=>{throw Object.assign(new Error('Denied'),{name:'NotAllowedError'});});
  await denied.tracker.start();assert.ok(denied.errors[0].includes('avslått'));assert.equal(denied.video.srcObject,null);
  let release;
  const pending=fixture(()=>new Promise(resolve=>{release=resolve;})),starting=pending.tracker.start();
  pending.tracker.stop();release(pending.stream);await starting;
  assert.equal(pending.stops(),1);assert.equal(pending.video.srcObject,null);assert.equal(pending.workers.length,0);
});

test('a bitmap returned after stopping is closed rather than transferred to a dead worker',async()=>{
  let release,closed=0;
  const active=fixture(undefined,()=>new Promise(resolve=>{release=resolve;}));
  await active.tracker.start();const sending=active.tracker.sendFrame(1200);
  active.tracker.stop();release({close(){closed++;}});await sending;
  assert.equal(closed,1);assert.equal(active.stops(),1);
});

function workerContext() {
  const messages=[],network=[],imports=[];
  class XHR {open(...args){network.push(args);}}
  const context=vm.createContext({URL,Request,XMLHttpRequest:XHR,postMessage:message=>messages.push(message),
    location:{origin:'https://entropi.iverfinne.no'},fetch:async(...args)=>{network.push(args);return new Response('asset');}});
  context.self=context;
  context.importScripts=(...files)=>{
    for(const file of files){imports.push(file);vm.runInContext(fs.readFileSync('static'+file,'utf8'),context);}
  };
  vm.runInContext(fs.readFileSync('static/pointcloud/vision/head-worker.js','utf8'),context);
  return {context,messages,network,imports};
}

test('pinned MediaPipe loads in the classic worker, responds with numeric motion only and closes bitmaps',async()=>{
  const {context,messages}=workerContext();let closed=0;
  assert.equal(typeof context.exports.FaceDetector.createFromOptions,'function');
  context.exports.FilesetResolver.forVisionTasks=async()=>({});
  context.exports.FaceDetector.createFromOptions=async(_vision,options)=>{
    assert.equal(options.baseOptions.modelAssetPath,'/pointcloud/vision/blaze-face-short-range.tflite');
    assert.equal(options.baseOptions.delegate,'CPU');
    return {detectForVideo(){return {detections:[
      {boundingBox:{originX:10,originY:20,width:100,height:100},keypoints:[{x:.4,y:.4},{x:.6,y:.4}]}
    ]};}};
  };
  await context.onmessage({data:{type:'init'}});
  await context.onmessage({data:{type:'frame',image:{width:640,height:480,close(){closed++;}},timestamp:1000}});
  assert.equal(messages[0].type,'ready');assert.equal(messages[1].type,'face');
  assert.equal(messages[1].face.x,.5);assert.deepEqual(Object.keys(messages[1].face),['x','y','size']);
  assert.equal(closed,1);
  const model=fs.readFileSync('static/pointcloud/vision/blaze-face-short-range.tflite');
  assert.equal(createHash('sha256').update(model).digest('hex'),'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f');
});

test('the real worker network guard blocks remote metrics, camera uploads and non-asset script imports',async()=>{
  const {context,network}=workerContext();
  await context.fetch('/pointcloud/vision/blaze-face-short-range.tflite');assert.equal(network.length,1);
  assert.equal(network[0][1].redirect,'error');
  for(const [url,options] of [
    ['https://www.google-analytics.com/collect'],['https://other.test/pointcloud/vision/tasks-vision.js'],
    ['/pointcloud/vision/blaze-face-short-range.tflite',{method:'POST',body:'frame'}],
    ['/pointcloud/vision/blaze-face-short-range.tflite?frame=secret'],['/api/camera-upload']
  ])await assert.rejects(context.fetch(url,options),/Only local/);
  assert.throws(()=>new context.XMLHttpRequest().open('POST','/api/camera-upload'),/Only local/);
  assert.throws(()=>context.importScripts('https://remote.test/tracking.js'),/Only local/);
  assert.equal(network.length,1);
});
