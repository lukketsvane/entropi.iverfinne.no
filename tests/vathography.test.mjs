import test from 'node:test';
import assert from 'node:assert/strict';
import { VATHOGRAPHY_PRESETS, normalizeDepth, prepareToneDepth } from '../src/lib/vathography.mjs';

const ramp = Float32Array.from({ length: 64 }, (_, i) => i / 63);
const tone = prepareToneDepth(ramp, 64, 1);
const row = options => Array.from({ length: 64 }, (_, i) => tone(options)[i * 4]);

test('inverse depth becomes log depth from 0 near to 1 far, with sky and missing values handled', () => {
  assert.deepEqual(Array.from(normalizeDepth(Float32Array.from([8, 4, 2, 0]))), [0, .5, 1, 1]);
  const capped = normalizeDepth(Float32Array.from([100, 10, 1, .5]));
  assert.ok(Math.abs(capped[1] - Math.log(10) / Math.log(20)) < 1e-6); assert.deepEqual(Array.from(capped.slice(2)), [1, 1]);
  assert.deepEqual(Array.from(normalizeDepth(Float32Array.from([3, 3]))), [.5, .5]);
  assert.equal(normalizeDepth(Float32Array.from([4, NaN, 1]))[1], .5);
  assert.throws(() => normalizeDepth(Float32Array.from([NaN])), /gyldige/);
});

test('mist darkens near surfaces and lightens the distance, while near light reverses it', () => {
  const mist = row({ preset: 1 }), near = row({ preset: 3 });
  assert.ok(mist[0] < 5 && mist[63] > 245); assert.ok(near[0] > 245 && near[63] < 5);
  for (let i = 1; i < 64; i++) { assert.ok(mist[i] >= mist[i - 1]); assert.ok(near[i] <= near[i - 1]); }
});

test('the light band follows the depth position and narrows with the band width', () => {
  const peak = values => values.indexOf(Math.max(...values));
  const centre = peak(row({ preset: 0 })), nearer = peak(row({ preset: 0, position: -.3 }));
  assert.ok(nearer < centre - 10);
  const lit = values => { let low = peak(values), high = low; while (values[low - 1] > 128) low--; while (values[high + 1] > 128) high++; return high - low + 1; };
  assert.ok(lit(row({ preset: 0, width: .5 })) < lit(row({ preset: 0, width: 2 })));
  assert.equal(VATHOGRAPHY_PRESETS.length, 5);
  assert.equal(new Set(VATHOGRAPHY_PRESETS.map((_, preset) => row({ preset }).join())).size, 5);
});

test('rendering resamples depth to the photograph as opaque greyscale', () => {
  const field = prepareToneDepth(Float32Array.from([0, 1, 1, 0]), 2, 2);
  const image = field({ preset: 1, outputWidth: 6, outputHeight: 4 });
  assert.equal(image.length, 6 * 4 * 4);
  for (let i = 0; i < image.length; i += 4) assert.ok(image[i] === image[i + 1] && image[i] === image[i + 2] && image[i + 3] === 255);
  assert.throws(() => prepareToneDepth(new Float32Array(3), 2, 2), /Ugyldig/);
});
