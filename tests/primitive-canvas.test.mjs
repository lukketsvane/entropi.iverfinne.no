import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasPointCloudViewer} from '../src/lib/pointcloud/canvas-viewer.mjs';

test('rectangular retro pixels preserve Canvas scene framing, pan, eye position and point shape', () => {
  for (const [width, height] of [[390, 844], [844, 390]]) {
    const context = {
      clearRect() {}, fillRect() {}, drawImage() {},
      getImageData: (_x, _y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)}),
      putImageData() {}
    };
    const scratch = {width: 1, height: 1, getContext: () => context};
    const viewer = Object.assign(Object.create(CanvasPointCloudViewer.prototype), {
      canvas: {width, height}, context, primitiveCanvas: scratch, primitiveLevel: 0,
      cloud: {positions: Float32Array.from([.2, .3, .4, -.3, -.1, -.2]), colors: new Uint8Array(6).fill(170), radius: 1},
      indices: [0, 1], projected: new Float32Array(6), order: [0, 1],
      yaw: .16, pitch: .04, zoom: .9, panX: 13, panY: -8, pointSize: 1, definition: .5, style: 'mono',
      parallax: {offsets: (_distance, aspect) => {
        assert.equal(aspect, width / height);
        return {x: .1, y: -.08, z: .04, scale: 1.02, screen: 2.5};
      }}
    });
    const normalized = (w, h) => [...viewer.projected].map((value, i) => value / (i % 3 === 0 ? w : i % 3 === 1 ? h : 1));
    viewer.render(1000);
    const original = normalized(width, height);
    for (const level of [1, 2, 3]) {
      viewer.setPrimitiveLevel(level);
      viewer.render(1000);
      const reduced = normalized(scratch.width, scratch.height);
      reduced.forEach((value, i) => assert.ok(Math.abs(value - original[i]) < 1e-6));
      assert.equal(viewer.canvas.width, width);
      assert.equal(viewer.canvas.height, height);
      assert.equal(context.imageSmoothingEnabled, false);
      viewer.render(1000, true);
      assert.deepEqual(normalized(width, height), original, 'printing uses the original framing');
    }
  }
});
