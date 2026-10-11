import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera,Vector3} from 'three';
import {HeadParallax} from '../src/lib/pointcloud/head-parallax.mjs';
import {CanvasPointCloudViewer} from '../src/lib/pointcloud/canvas-viewer.mjs';

test('moving the eye keeps the virtual screen fixed and separates near and far depth on iPhone',()=>{
  for(const [width,height] of [[390,844],[393,852],[430,932],[844,390]]) {
    const base=new PerspectiveCamera(48,width/height,.01,100),focus=new Vector3(.1,-.05,0);
    base.position.set(.25,.07,3);base.lookAt(focus);base.updateMatrixWorld(true);
    const original=base.clone(),distance=base.position.distanceTo(focus);
    const forward=new Vector3(0,0,-1).applyQuaternion(base.quaternion);
    const screen=base.position.clone().addScaledVector(forward,distance*.8);
    const planePoint=screen.clone().add(new Vector3(.12,.08,0).applyQuaternion(base.quaternion));
    const planeBefore=planePoint.clone().project(base),effect=new HeadParallax();
    for(const pose of [{x:1,y:1,z:1},{x:-1,y:-.7,z:-1}]) {
      effect.setPose(pose);
      let view;
      for(let step=0;step<90;step++)view=effect.camera(base,focus,10000+(pose.x+2)*2000+step*17);
      const projected=planePoint.clone().project(view);
      assert.ok(Math.hypot(projected.x-planeBefore.x,projected.y-planeBefore.y)<1e-8);
      const near=screen.clone().addScaledVector(forward,-distance*.2).project(view);
      const far=screen.clone().addScaledVector(forward,distance*.2).project(view);
      assert.ok(near.x*far.x<0,'Points either side of the screen move in opposite directions');
      assert.ok(view.position.distanceTo(base.position)>.01);
      assert.ok(base.position.equals(original.position));
      assert.ok(base.projectionMatrix.equals(original.projectionMatrix));
      assert.ok(view.projectionMatrix.elements.every(Number.isFinite));
    }
    effect.setPose(null);
    for(let step=0;step<90;step++)effect.camera(base,focus,50000+step*17);
    assert.ok(effect.view.position.distanceTo(base.position)<1e-10);
    assert.ok(effect.view.projectionMatrix.equals(base.projectionMatrix));
    effect.setPose({x:NaN,y:Infinity,z:-Infinity});
    assert.ok(effect.camera(base,focus,55000).projectionMatrix.elements.every(Number.isFinite));
  }
});

test('head perspective follows a newly orbited camera and reduced motion dampens displacement',()=>{
  const camera=new PerspectiveCamera(48,390/844,.01,100),focus=new Vector3();
  camera.position.set(3,0,0);camera.lookAt(focus);camera.updateMatrixWorld(true);
  const full=new HeadParallax(),reduced=new HeadParallax();
  full.setPose({x:1,y:0,z:0});reduced.setPose({x:1,y:0,z:0});
  let first,second;
  for(let step=0;step<90;step++) {
    first=full.camera(camera,focus,1000+step*17);
    second=reduced.camera(camera,focus,1000+step*17,true);
  }
  assert.ok(Math.abs(first.position.x-camera.position.x)<1e-9);
  assert.ok(Math.abs(first.position.z-camera.position.z)>.1,'Movement is in the orbit camera’s own right axis');
  assert.ok(Math.abs(second.position.distanceTo(camera.position)/first.position.distanceTo(camera.position)-.35)<1e-9);
});

test('the actual Canvas fallback projects head motion with depth while keeping its screen plane fixed',()=>{
  const viewer=Object.create(CanvasPointCloudViewer.prototype);
  Object.assign(viewer,{
    canvas:{width:390,height:844},context:{fillStyle:'',clearRect(){},fillRect(){}},
    cloud:{positions:Float32Array.from([0,0,1.12, 0,0,.56, 0,0,0]),colors:new Uint8Array(9).fill(200),radius:1},
    indices:[0,1,2],projected:new Float32Array(9),order:[0,1,2],
    yaw:0,pitch:0,zoom:1,panX:0,panY:0,pointSize:1,style:'crt',
    auto:true,dirty:false,reducedMotion:false,parallax:new HeadParallax()
  });
  viewer.render(1000);
  const neutral=viewer.projected.slice();
  viewer.setHeadPose({x:1,y:.6,z:.5});
  for(let step=0;step<90;step++)viewer.render(1100+step*17);
  assert.equal(viewer.auto,false);
  assert.ok(viewer.projected[0]<neutral[0]&&viewer.projected[6]>neutral[6]);
  assert.ok(Math.abs(viewer.projected[3]-neutral[3])<1e-4);
  assert.ok(Math.abs(viewer.projected[4]-neutral[4])<1e-4);
  assert.ok(viewer.projected.every(Number.isFinite));
  viewer.setHeadPose(null);
  for(let step=0;step<90;step++)viewer.render(5000+step*17);
  assert.deepEqual(viewer.projected,neutral);
});
