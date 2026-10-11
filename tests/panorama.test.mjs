import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbnail, estimateTranslation, stitchFrames } from '../static/pointcloud/panorama.mjs';

const sceneW = 220, sceneH = 170;
const scene = new Uint8ClampedArray(sceneW * sceneH * 4);
for (let y = 0; y < sceneH; y++) for (let x = 0; x < sceneW; x++) {
  const i = (y * sceneW + x) * 4;
  const v = (x * 17 + y * 13 + ((x * 92821 ^ y * 68917) >>> 4)) & 255;
  scene[i] = v; scene[i+1] = (v + x * 3) & 255;
  scene[i+2] = (v + y * 2) & 255; scene[i+3] = 255;
}
function frame(offsetX = 0, offsetY = 0) {
  const width = 120, height = 90, rgba = new Uint8ClampedArray(width*height*4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = ((y + offsetY) * sceneW + x + offsetX) * 4;
    rgba.set(scene.subarray(from,from+4),(y*width+x)*4);
  }
  return {width,height,rgba};
}

test('matches actual horizontal panning rather than merely stacking frames', () => {
  const first = frame(), next = frame(22);
  const shift = estimateTranslation(thumbnail(first),thumbnail(next));
  assert.ok(shift);
  assert.ok(Math.abs(shift.dx * first.width / thumbnail(first).width + 22) < 3);
  assert.ok(Math.abs(shift.dy) < 3);
  const pano = stitchFrames([first,next]);
  assert.equal(pano.captured,2);
  assert.equal(pano.accepted,2);
  assert.ok(pano.width > first.width + 16);
  assert.equal(pano.height,first.height);
  assert.equal(pano.rgba.length,pano.width*pano.height*4);
});

test('registers upward camera motion and keeps bounded output', () => {
  const pano = stitchFrames([frame(0,0),frame(8,12),frame(17,24)],{maxWidth:125,maxHeight:95,maxPixels:10000});
  assert.equal(pano.captured,3);
  assert.ok(pano.accepted >= 2);
  assert.ok(pano.width <= 125 && pano.height <= 95);
  assert.ok(pano.width*pano.height <= 10000);
});

test('stationary repeated frames do not create invented panorama width', () => {
  const pano = stitchFrames([frame(),frame(),frame()]);
  assert.equal(pano.width,120);
  assert.equal(pano.height,90);
  assert.equal(pano.accepted,1);
});

test('rejects malformed or oversized frames', () => {
  assert.throws(() => stitchFrames([]),/sequence/);
  assert.throws(() => stitchFrames([frame(),{...frame(),width:121}]),/pixels/);
  assert.throws(() => stitchFrames(Array.from({length:37},()=>frame())),/sequence/);
});
