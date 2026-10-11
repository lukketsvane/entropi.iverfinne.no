import test from 'node:test';
import assert from 'node:assert/strict';
import {imageToPointCloud, pointStride} from '../static/pointcloud/math.mjs';

test('recorded video frames are accepted by the worker and produce a 3D-ready panorama', async () => {
  const responses = [];
  const originalSelf = globalThis.self;
  try {
    globalThis.self = {postMessage: (value) => responses.push(value)};
    await import('../static/pointcloud/panorama-worker.mjs');
    const width = 160, height = 120;
    const makeFrame = (offset) => {
      const data = new Uint8ClampedArray(width*height*4);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=(y*width+x)*4, px=x+offset;
        data[i]=110+70*Math.sin(px*.19+Math.cos(y*.17)*3);
        data[i+1]=100+65*Math.cos(y*.23+Math.sin(px*.11)*2);
        data[i+2]=100+50*Math.sin(px*.13+y*.21);
        data[i+3]=255;
      }
      return {width,height,data:data.buffer};
    };
    // The exact array payload used by src/routes/+page.svelte.
    globalThis.self.onmessage({data:[makeFrame(0),makeFrame(25),makeFrame(50)]});
    assert.equal(responses.length,1);
    const response = responses[0];
    assert.equal(response.type,'result');
    assert.equal(response.inputFrames,3);
    assert.equal(response.registeredFrames,3);
    assert.ok(response.width>width);
    assert.ok(response.height>=height);
    assert.ok(response.data instanceof ArrayBuffer);
    assert.equal(response.data.byteLength,response.width*response.height*4);
    // Validate that the real panorama pixels reach the same 3D cloud
    // conversion path used by the iPhone camera, given a depth prediction.
    const depth = new Float32Array(response.width*response.height);
    for(let y=0;y<response.height;y++)for(let x=0;x<response.width;x++)
      depth[y*response.width+x] = Math.sin(x*.01)+Math.cos(y*.02);
    const cloud = imageToPointCloud({
      rgba: new Uint8ClampedArray(response.data),
      width: response.width, height: response.height,
      depth, depthWidth: response.width, depthHeight: response.height,
      stride: pointStride(response.width,response.height)
    });
    assert.ok(cloud.count > 100);
    assert.ok(cloud.positions.every(Number.isFinite));
  } finally {
    globalThis.self=originalSelf;
  }
});

test('invalid recording returns a typed error instead of an unhandled blank screen', async () => {
  const messages=[];
  const originalSelf=globalThis.self;
  try {
    globalThis.self={postMessage: value=>messages.push(value)};
    await import('../static/pointcloud/panorama-worker.mjs?invalid-case');
    globalThis.self.onmessage({data:[]});
    assert.equal(messages.length,1);
    assert.equal(messages[0].type,'error');
    assert.ok(messages[0].message);
  } finally {
    globalThis.self=originalSelf;
  }
});
