import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOKS, finishArt, photoDetail, boxBlur } from '../src/lib/finish.mjs';
import { prepareToneDepth } from '../src/lib/vathography.mjs';

const grey = values => Uint8ClampedArray.from(values.flatMap(v => [v, v, v, 255]));

test('mono with no structure or grain leaves the depth tone untouched', () => {
  const pixels = grey([0, 64, 128, 255]);
  assert.deepEqual(Array.from(finishArt(pixels.slice(), 4, 1, {})), Array.from(pixels));
});

test('a colour look maps dark to its first stop and light to its last, and strength mixes with mono', () => {
  const blue = LOOKS.findIndex(look => look.id === 'blue');
  const pixels = finishArt(grey([0, 255]), 2, 1, { look: blue });
  assert.deepEqual(Array.from(pixels.slice(0, 3)), LOOKS[blue].stops[0][1]);
  assert.deepEqual(Array.from(pixels.slice(4, 7)), LOOKS[blue].stops.at(-1)[1]);
  const half = finishArt(grey([0]), 1, 1, { look: blue, strength: .5 });
  LOOKS[blue].stops[0][1].forEach((c, i) => assert.ok(Math.abs(half[i] - c / 2) <= 1));
  assert.ok(LOOKS.length >= 6 && new Set(LOOKS.map(look => look.id)).size === LOOKS.length);
});

test('structure carries the photograph\'s fine detail into the depth tone, and grain is repeatable', () => {
  const width = 32, height = 32, photo = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) photo.set((i % width) % 4 < 2 ? [240, 240, 240, 255] : [20, 20, 20, 255], i * 4);
  const detail = photoDetail(photo, width, height), base = grey(Array(width * height).fill(128));
  const textured = finishArt(base.slice(), width, height, { structure: 1 }, detail);
  const values = new Set(Array.from({ length: width }, (_, x) => textured[x * 4]));
  assert.ok(values.size > 2, 'Window-like stripes appear in a flat depth tone');
  const once = finishArt(base.slice(), width, height, { grain: 1 }), again = finishArt(base.slice(), width, height, { grain: 1 });
  assert.deepEqual(once, again); assert.notDeepEqual(once, base);
});

test('box blur keeps a constant field and sharpening steepens depth edges', () => {
  assert.deepEqual(Array.from(boxBlur(new Float32Array(12).fill(3), 4, 3, 1)), Array(12).fill(3));
  const step = Float32Array.from({ length: 16 }, (_, i) => (i % 16) < 8 ? .2 : .8);
  const tone = prepareToneDepth(step, 16, 1);
  const soft = tone({ preset: 1 }), sharp = tone({ preset: 1, sharpen: 1 });
  assert.ok(Math.abs(sharp[7 * 4] - sharp[8 * 4]) > Math.abs(soft[7 * 4] - soft[8 * 4]));
  assert.deepEqual(tone({ preset: 1, sharpen: 0 }), soft);
});

test('every dither style turns a ramp into two tones and keeps its average', async () => {
  const { DITHERS, ditherTone } = await import('../src/lib/finish.mjs');
  for (const { id } of DITHERS.slice(1)) for (const cell of [1, 6]) {
    const tone = new Uint8ClampedArray(64 * 64).map((_, i) => (i % 64) * 4);
    ditherTone(tone, 64, 64, id, cell, 0);
    assert.ok(tone.every(v => v === 0 || v === 255), id);
    const mean = tone.reduce((sum, v) => sum + v, 0) / tone.length;
    assert.ok(Math.abs(mean - 126) < 16, `${id} ${cell}: ${mean}`);
  }
});

test('dithering follows the look ramp, and invert swaps its ends', async () => {
  const { finishArt } = await import('../src/lib/finish.mjs');
  const pixels = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  finishArt(pixels, 16, 16, { dither: 1 });
  assert.ok(pixels.every((v, i) => i % 4 === 3 || v === 0 || v === 255));
  const inverted = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  finishArt(inverted, 16, 16, { dither: 1, invert: true });
  for (let i = 0; i < pixels.length; i += 4) assert.equal(inverted[i], 255 - pixels[i]);
});
