import test from 'node:test';
import assert from 'node:assert/strict';
import {C64_PALETTE, nearestC64} from '../src/lib/pointcloud/c64-palette.ts';

test('C64 palette contains the specified 16 Colodore colours', () => {
  assert.deepEqual(C64_PALETTE.map(color => color.map(channel => channel.toString(16).padStart(2, '0')).join('')), [
    '000000', 'ffffff', '96282e', '5bd6ce', '9f2dad', '41b936', '2724c4', 'eff347',
    '9f4815', '5e3500', 'da5f66', '474747', '787878', '91ff84', '6864ff', 'aeaeae'
  ]);
});

test('palette mapping keeps exact colours and preserves object hues', () => {
  for (const color of C64_PALETTE) assert.deepEqual(nearestC64(...color), color);
  assert.deepEqual(nearestC64(148, 42, 47), [150, 40, 46]);
  assert.deepEqual(nearestC64(127, 126, 129), [120, 120, 120]);
  assert.deepEqual(nearestC64(233, 241, 75), [239, 243, 71]);
  assert.deepEqual(nearestC64(48, 127, 166), [91, 214, 206]);
  assert.deepEqual(nearestC64(185, 64, 56), [150, 40, 46]);
});
