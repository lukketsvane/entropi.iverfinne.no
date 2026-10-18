import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PRIMITIVE_MODES, primitiveDimensions, primitiveColor, applyPrimitivePixels} from '../src/lib/pointcloud/primitive-style.ts';
import {PrimitiveEffect} from '../src/lib/pointcloud/primitive-effect.mjs';

test('the original view passes through its colours, resolution and alpha', () => {
  assert.deepEqual(primitiveColor(0, 123, 45, 67, 0, 0), [123, 45, 67]);
  assert.deepEqual(primitiveDimensions(0, 1179, 2556), {width: 1179, height: 2556});
  const pixels = new Uint8ClampedArray([123, 45, 67, 89]);
  assert.equal(applyPrimitivePixels(0, pixels, 1, 1), pixels);
  assert.deepEqual([...pixels], [123, 45, 67, 89]);
});

test('all quantized output belongs to the selected historical palette', () => {
  for (let level = 1; level <= 3; level++) {
    const palette = new Set(PRIMITIVE_MODES[level].palette.map(color => color.join(',')));
    for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
      for (let x = 0; x < 4; x++) assert.ok(palette.has(primitiveColor(level, r, g, b, x, r % 4).join(',')));
    }
  }
});

test('exact palette swatches and black backgrounds stay exact at every Bayer phase', () => {
  for (let level = 1; level <= 3; level++) for (const color of PRIMITIVE_MODES[level].palette) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.deepEqual(primitiveColor(level, ...color, x, y), color);
  }
});

test('ordered dither is deterministic, repeats every four pixels, and adds intermediate tones', () => {
  for (let level = 1; level <= 3; level++) {
    const pattern = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const color = primitiveColor(level, 127, 127, 127, x, y);
      pattern.push(color.join(','));
      assert.deepEqual(color, primitiveColor(level, 127, 127, 127, x + 4, y + 8));
      assert.deepEqual(color, primitiveColor(level, 127, 127, 127, x - 4, y - 8));
    }
    assert.ok(new Set(pattern).size > 1, `level ${level} should dither middle tones`);
  }
  const onPixels = value => Array.from({length: 16}, (_, i) => primitiveColor(3, value, value, value, i % 4, Math.floor(i / 4))[1]).filter(Boolean).length;
  assert.ok(onPixels(50) < onPixels(100));
  assert.ok(onPixels(100) < onPixels(150));
});

test('old display dimensions fit portrait and landscape views with their intended pixel shape', () => {
  for (let level = 1; level <= 3; level++) for (const [width, height] of [[1920, 1080], [1080, 1920], [512, 512], [7, 19]]) {
    const size = primitiveDimensions(level, width, height), mode = PRIMITIVE_MODES[level];
    assert.ok(size.width >= 1 && size.height >= 1);
    assert.ok(size.width <= mode.width && size.height <= mode.height);
    const displayedAspect = size.width * mode.pixelAspect / size.height;
    const tolerance = mode.pixelAspect / size.height + displayedAspect / size.height;
    assert.ok(Math.abs(displayedAspect - width / height) <= tolerance);
  }
  assert.deepEqual(primitiveDimensions(2, 1600, 1200), {width: 320, height: 200});
  assert.deepEqual(primitiveDimensions(3, NaN, Infinity), {width: 1, height: 1});
  assert.deepEqual(primitiveDimensions(NaN, -10, 0), {width: 1, height: 1});
  assert.ok(primitiveColor(3, NaN, Infinity, -1, NaN, Infinity).every(Number.isFinite));
});

test('Canvas2D treatment mutates the supplied buffer and resolves transparency onto black', () => {
  const pixels = new Uint8ClampedArray([255, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255, 255]);
  assert.equal(applyPrimitivePixels(2, pixels, 3, 1), pixels);
  assert.deepEqual([...pixels], [255, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255]);
});

function fakeRenderer() {
  return {
    extensions: {has: () => true},
    autoClear: true, target: null, color: new THREE.Color(.1, .2, .3), alpha: .4, calls: [],
    getRenderTarget() { return this.target; },
    getActiveCubeFace() { return 0; }, getActiveMipmapLevel() { return 0; },
    getDrawingBufferSize(value) { return value.set(1600, 1200); },
    getClearColor(value) { return value.copy(this.color); }, getClearAlpha() { return this.alpha; },
    setClearColor(value, alpha) { this.color.set(value); this.alpha = alpha; },
    setRenderTarget(value) { this.target = value; },
    clear() { this.calls.push(['clear', this.target]); },
    render(scene, camera) { this.calls.push(['render', this.target, scene, camera]); }
  };
}

test('the screen effect preserves renderer resolution and state and bypasses its buffers at level zero', () => {
  const renderer = fakeRenderer(), effect = new PrimitiveEffect(renderer), scene = new THREE.Scene(), camera = new THREE.Camera();
  effect.render(scene, camera);
  assert.deepEqual(renderer.calls, [['render', null, scene, camera]]);
  renderer.calls.length = 0;
  const before = renderer.color.clone();
  effect.setLevel(2); effect.render(scene, camera);
  assert.equal(renderer.calls[1][1], effect.target);
  assert.equal(renderer.calls[2][1], null);
  assert.equal(effect.target.width, 320); assert.equal(effect.target.height, 200);
  assert.equal(renderer.target, null); assert.equal(renderer.autoClear, true);
  assert.equal(renderer.alpha, .4); assert.ok(renderer.color.equals(before));
  assert.equal(effect.material.toneMapped, false);
  assert.equal(effect.material.blending, THREE.NoBlending);
  effect.dispose(); effect.dispose();
});

test('devices without float attachments use a core WebGL2 sRGB render target', () => {
  const renderer = fakeRenderer(); renderer.extensions.has = () => false;
  const effect = new PrimitiveEffect(renderer);
  assert.equal(effect.target.texture.type, THREE.UnsignedByteType);
  assert.equal(effect.target.texture.colorSpace, THREE.SRGBColorSpace);
  effect.dispose();
});

test('a failed scene render restores the caller target and clear settings', () => {
  const renderer = fakeRenderer(), original = new THREE.WebGLRenderTarget(800, 600);
  renderer.target = original; renderer.autoClear = false;
  const before = renderer.color.clone(), effect = new PrimitiveEffect(renderer);
  effect.setLevel(1);
  renderer.render = () => { throw new Error('scene failed'); };
  assert.throws(() => effect.render(new THREE.Scene(), new THREE.Camera()), /scene failed/);
  assert.equal(renderer.target, original); assert.equal(renderer.autoClear, false);
  assert.equal(renderer.alpha, .4); assert.ok(renderer.color.equals(before));
  effect.dispose(); original.dispose();
});
