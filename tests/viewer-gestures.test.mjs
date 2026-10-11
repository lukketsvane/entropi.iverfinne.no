import test from 'node:test';
import assert from 'node:assert/strict';
import {attachViewerGestures, progressiveIndices} from '../src/lib/pointcloud/viewer-gestures.ts';

function canvas() {
  const listeners = new Map();
  return {
    clientWidth: 400, clientHeight: 800, style: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    setPointerCapture() {},
    getBoundingClientRect() { return {left: 10, top: 20}; },
    send(type, pointerId, x, y) {
      const event = {pointerType: 'touch', pointerId, clientX: x, clientY: y, stopped: false, prevented: false,
        stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }};
      listeners.get(type)(event);
      return event;
    }
  };
}

function callbacks() {
  const rotate = [], transform = [], density = [], definition = [], touch = [], adjust = [];
  return {rotate, transform, density, definition, touch, adjust,
    options: {
      onRotate: (...values) => rotate.push(values),
      onTransform: (...values) => transform.push(values),
      onDensity: value => density.push(value),
      onDefinition: value => definition.push(value),
      onTouch: value => touch.push(value),
      onAdjust: (...values) => adjust.push(values)
    }};
}

test('staggered two-finger drag pans without locking into pinch', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, calls.options);
  assert.equal(surface.send('pointerdown', 1, 100, 300).stopped, false);
  assert.equal(surface.send('pointerdown', 2, 300, 300).stopped, false);
  assert.equal(surface.send('pointermove', 1, 120, 300).stopped, true);
  surface.send('pointermove', 2, 320, 300);
  assert.equal(calls.transform.length, 2);
  assert.equal(calls.transform.reduce((sum, [dx]) => sum + dx, 0), 20);
  assert.ok(Math.abs(calls.transform.reduce((scale, [, , ratio]) => scale * ratio, 1) - 1) < 1e-9);
  assert.deepEqual(calls.transform[0].slice(3), [200, 280]);
  assert.deepEqual(calls.density, []);
  assert.deepEqual(calls.definition, []);
  assert.equal(surface.send('pointerup', 2, 320, 300).stopped, false);
  surface.send('pointerup', 1, 120, 300);
  assert.deepEqual(calls.touch, [true, false]);
  gestures.dispose();
});

test('two-finger movement combines pan and pinch', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, calls.options);
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 300, 300);
  surface.send('pointermove', 1, 80, 300);
  surface.send('pointermove', 2, 340, 300);
  assert.equal(calls.transform.reduce((sum, [dx]) => sum + dx, 0), 10);
  assert.ok(Math.abs(calls.transform.reduce((scale, [, , ratio]) => scale * ratio, 1) - 1.3) < 1e-9);
  assert.deepEqual(calls.rotate, []);
  gestures.dispose();
  assert.deepEqual(calls.touch, [true, false]);
});

test('one, two and three finger transitions preserve deltas and resume rotation', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, calls.options);
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointermove', 1, 110, 300);
  surface.send('pointerdown', 2, 300, 300);
  surface.send('pointermove', 1, 120, 300);
  surface.send('pointerdown', 3, 200, 400);
  surface.send('pointermove', 3, 200, 406);
  surface.send('pointerup', 3, 200, 406);
  surface.send('pointermove', 2, 310, 300);
  surface.send('pointerup', 2, 310, 300);
  surface.send('pointermove', 1, 130, 300);
  assert.deepEqual(calls.rotate, [[10, 0], [10, 0]]);
  assert.equal(calls.transform.length, 2);
  assert.deepEqual(calls.touch, [true]);
  surface.send('pointercancel', 1, 130, 300);
  assert.deepEqual(calls.touch, [true, false]);
  gestures.dispose();
});

test('three-finger vertical drag changes density and next capture quality only', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, calls.options);
  surface.send('pointerdown', 1, 100, 100);
  surface.send('pointerdown', 2, 200, 100);
  surface.send('pointerdown', 3, 300, 100);
  for (let y = 136; y <= 640; y += 36) {
    surface.send('pointermove', 1, 100, y);
    surface.send('pointermove', 2, 200, y);
    surface.send('pointermove', 3, 300, y);
  }
  assert.ok(calls.density.at(-1) < .00001);
  assert.deepEqual(calls.definition, []);
  assert.deepEqual(calls.transform, []);
  surface.send('pointerup', 3, 300, 640);
  surface.send('pointerup', 2, 200, 640);
  surface.send('pointerup', 1, 100, 640);
  assert.ok(calls.adjust[0][1] < .1);
  assert.match(calls.adjust[0][0], /Viste element .* Punktskarpleik/);
  gestures.dispose();
});

test('a lower selected detail level continues from its visible density', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, {...calls.options, initialDensity: .38});
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 200, 300);
  surface.send('pointerdown', 3, 300, 300);
  surface.send('pointermove', 1, 100, 360);
  surface.send('pointermove', 2, 200, 360);
  surface.send('pointermove', 3, 300, 360);
  assert.ok(calls.density[0] < .38 && calls.density[0] > 0);
  surface.send('pointerup', 3, 300, 360);
  surface.send('pointerup', 2, 200, 360);
  surface.send('pointerup', 1, 100, 360);
  assert.equal(calls.adjust[0][1], calls.density.at(-1));
  gestures.dispose();
});

test('three-finger upward drag can select maximum next capture quality from a full scene', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, calls.options);
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 200, 300);
  surface.send('pointerdown', 3, 300, 300);
  surface.send('pointermove', 1, 100, 260);
  surface.send('pointermove', 2, 200, 260);
  surface.send('pointermove', 3, 300, 260);
  surface.send('pointerup', 3, 300, 260);
  surface.send('pointerup', 2, 200, 260);
  surface.send('pointerup', 1, 100, 260);
  assert.deepEqual(calls.density, []);
  assert.equal(calls.adjust[0][1], 1);
  gestures.dispose();
});

test('three-finger horizontal drag locks definition despite later vertical movement', () => {
  const surface = canvas(), calls = callbacks();
  const gestures = attachViewerGestures(surface, calls.options);
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 200, 300);
  surface.send('pointerdown', 3, 300, 300);
  surface.send('pointermove', 1, 140, 300);
  surface.send('pointermove', 2, 240, 300);
  surface.send('pointermove', 3, 340, 300);
  surface.send('pointermove', 1, 140, 400);
  surface.send('pointermove', 2, 240, 400);
  surface.send('pointermove', 3, 340, 400);
  assert.ok(calls.definition.at(-1) > .5);
  assert.deepEqual(calls.density, []);
  surface.send('pointerup', 3, 340, 400);
  surface.send('pointerup', 2, 240, 400);
  surface.send('pointerup', 1, 140, 400);
  assert.deepEqual(calls.adjust[0][1], null);
  gestures.dispose();
});

test('progressive indices cover each point exactly once', () => {
  const indices = progressiveIndices(1000);
  assert.equal(new Set(indices).size, 1000);
  assert.ok(Math.max(...indices.slice(0, 100)) > 800);
  assert.ok(Math.min(...indices.slice(0, 100)) < 200);
});
