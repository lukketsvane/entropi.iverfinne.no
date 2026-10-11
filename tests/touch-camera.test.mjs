import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera, Vector3} from 'three';
import {rotateTouchCamera, transformTouchCamera} from '../src/lib/pointcloud/touch-camera.ts';

function view() {
  const camera = new PerspectiveCamera(60, 1, .01, 100);
  camera.position.set(0, 0, 5);
  const controls = {
    target: new Vector3(), minDistance: 1, maxDistance: 20, rotateSpeed: .4,
    update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); }
  };
  controls.update();
  return {camera, controls};
}

function screenX(point, camera) {
  return (point.clone().project(camera).x + 1) * 200;
}

test('one-finger rotation preserves distance to the orbit target', () => {
  const {camera, controls} = view();
  rotateTouchCamera(camera, controls, 100, 40, 400);
  assert.ok(Math.abs(camera.position.distanceTo(controls.target) - 5) < 1e-8);
  assert.ok(Math.abs(camera.position.x) > .1);
  assert.ok(Math.abs(camera.position.y) > .1);
});

test('pinch keeps the touched point under the fingers while zooming', () => {
  const {camera, controls} = view();
  const point = new Vector3(100 * 2 * 5 * Math.tan(Math.PI / 6) / 400, 0, 0);
  assert.ok(Math.abs(screenX(point, camera) - 300) < 1e-8);
  transformTouchCamera(camera, controls, 0, 0, 2, 300, 200, 400, 400);
  assert.ok(Math.abs(camera.position.distanceTo(controls.target) - 2.5) < 1e-8);
  assert.ok(Math.abs(screenX(point, camera) - 300) < 1e-8);
});

test('two-finger translation moves the scene and zoom respects bounds', () => {
  const {camera, controls} = view();
  const point = new Vector3();
  transformTouchCamera(camera, controls, 20, 0, 1, 200, 200, 400, 400);
  assert.ok(Math.abs(screenX(point, camera) - 220) < 1e-8);
  transformTouchCamera(camera, controls, 0, 0, 100, 200, 200, 400, 400);
  assert.equal(camera.position.distanceTo(controls.target), 1);
  transformTouchCamera(camera, controls, 0, 0, .001, 200, 200, 400, 400);
  assert.equal(camera.position.distanceTo(controls.target), 20);
});
