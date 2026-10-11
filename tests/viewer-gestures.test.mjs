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
    send(type, pointerId, x, y, timeStamp = 0) {
      const event = {pointerType: 'touch', pointerId, clientX: x, clientY: y, timeStamp, stopped: false, prevented: false,
        stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }};
      listeners.get(type)(event);
      return event;
    }
  };
}

test('two-finger hold then vertical pan changes display density and reports it on release', () => {
  const surface = canvas(), density = [], pinch = [], messages = [];
  const gestures = attachViewerGestures(surface, {onDensity: value => density.push(value), onPinch: value => pinch.push(value), onAdjust: value => messages.push(value)});
  surface.send('pointerdown', 1, 100, 300);
  assert.equal(surface.send('pointerdown', 2, 300, 300).prevented, true);
  surface.send('pointermove', 1, 100, 315, 500);
  surface.send('pointermove', 2, 300, 315, 510);
  assert.ok(density.at(-1) < 1);
  assert.ok(density.at(-1) < .75);
  assert.deepEqual(pinch, []);
  surface.send('pointerup', 2, 300, 315);
  surface.send('pointerup', 1, 100, 315);
  assert.match(messages[0], /Viste element 70 prosent av full mengd/);
  gestures.dispose();
});

test('a long downward pan reaches a near-empty splat budget while preserving capture quality range', () => {
  const surface = canvas(), density = [], quality = [];
  const gestures = attachViewerGestures(surface, {onDensity: value => density.push(value), onPinch() {}, onAdjust: (_, value) => quality.push(value)});
  surface.send('pointerdown', 1, 100, 100);
  surface.send('pointerdown', 2, 300, 100);
  for (let y = 130; y <= 640; y += 30) {
    surface.send('pointermove', 1, 100, y, 500 + y);
    surface.send('pointermove', 2, 300, y, 510 + y);
  }
  assert.ok(density.at(-1) < .00001);
  surface.send('pointerup', 2, 300, 640);
  surface.send('pointerup', 1, 100, 640);
  assert.ok(quality.at(-1) < .1);
  gestures.dispose();
});

test('two-finger hold then horizontal pan changes splat size without zooming or changing count', () => {
  const surface = canvas(), density = [], pinch = [], size = [], quality = [];
  const gestures = attachViewerGestures(surface, {onDensity: value => density.push(value), onPinch: value => pinch.push(value), onSize: value => size.push(value), onAdjust: (_, value) => quality.push(value)});
  surface.send('pointerdown', 1, 100, 300);
  assert.equal(surface.send('pointerdown', 2, 200, 300).stopped, false);
  surface.send('pointermove', 1, 70, 300, 500);
  surface.send('pointermove', 2, 170, 300, 510);
  surface.send('pointermove', 1, 0, 300, 520);
  assert.equal(surface.send('pointermove', 2, 100, 300, 530).stopped, true);
  assert.ok(size.at(-1) < .5);
  assert.deepEqual(density, []);
  assert.deepEqual(pinch, []);
  surface.send('pointerup', 2, 100, 300);
  surface.send('pointerup', 1, 0, 300);
  assert.deepEqual(quality, [null]);
  gestures.dispose();
});

test('pinching zooms without changing density', () => {
  const surface = canvas(), density = [], pinch = [];
  const gestures = attachViewerGestures(surface, {onDensity: value => density.push(value), onPinch: value => pinch.push(value)});
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 300, 300);
  surface.send('pointermove', 1, 80, 300, 50);
  surface.send('pointermove', 2, 320, 300, 60);
  assert.deepEqual(density, []);
  assert.ok(pinch.some(value => value > 1));
  gestures.dispose();
});

test('pinching after a two-finger hold still zooms', () => {
  const surface = canvas(), density = [], size = [], pinch = [], pan = [];
  const gestures = attachViewerGestures(surface, {onDensity: value => density.push(value), onSize: value => size.push(value), onPinch: value => pinch.push(value), onPan: (x, y) => pan.push([x, y])});
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 300, 300);
  surface.send('pointermove', 1, 80, 300, 500);
  surface.send('pointermove', 2, 320, 300, 510);
  assert.ok(pinch.some(value => value > 1));
  assert.deepEqual(density, []);
  assert.deepEqual(size, []);
  assert.deepEqual(pan, []);
  gestures.dispose();
});

test('ordinary two-finger drag pans without changing count, size or zoom', () => {
  const surface = canvas(), pan = [], density = [], size = [], pinch = [];
  const gestures = attachViewerGestures(surface, {onDensity: value => density.push(value), onSize: value => size.push(value), onPinch: value => pinch.push(value), onPan: (x, y) => pan.push([x, y])});
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 300, 300);
  surface.send('pointermove', 1, 115, 310, 50);
  surface.send('pointermove', 2, 315, 310, 60);
  surface.send('pointermove', 1, 135, 335, 75);
  surface.send('pointermove', 2, 335, 335, 85);
  assert.ok(pan.length > 0);
  assert.ok(pan.reduce((sum, [x]) => sum + x, 0) > 0);
  assert.ok(pan.reduce((sum, [, y]) => sum + y, 0) > 0);
  assert.deepEqual(density, []);
  assert.deepEqual(size, []);
  assert.deepEqual(pinch, []);
  gestures.dispose();
});

test('three-finger pan changes scene opacity vertically and contrast horizontally', () => {
  const surface = canvas(), messages = [], opacity = [], quality = [];
  const gestures = attachViewerGestures(surface, {onDensity() {}, onPinch() {}, onOpacity: value => opacity.push(value), onAdjust: (message, value) => { messages.push(message); quality.push(value); }});
  surface.send('pointerdown', 1, 100, 300);
  surface.send('pointerdown', 2, 200, 300);
  surface.send('pointerdown', 3, 300, 300);
  surface.send('pointermove', 1, 125, 325);
  surface.send('pointermove', 2, 225, 325);
  surface.send('pointermove', 3, 325, 325);
  assert.ok(gestures.state.opacity < 1);
  assert.equal(opacity.at(-1), gestures.state.opacity);
  assert.ok(gestures.state.contrast > 1);
  assert.match(surface.style.filter, /^contrast\(.+\)$/);
  surface.send('pointerup', 3, 325, 325);
  surface.send('pointerup', 2, 225, 325);
  surface.send('pointerup', 1, 125, 325);
  assert.match(messages[0], /Opasitet .* Kontrast/);
  assert.deepEqual(quality, [null]);
  gestures.dispose();
});

test('progressive indices cover each point exactly once', () => {
  const indices = progressiveIndices(1000);
  assert.equal(new Set(indices).size, 1000);
  assert.ok(Math.max(...indices.slice(0, 100)) > 800);
  assert.ok(Math.min(...indices.slice(0, 100)) < 200);
});
