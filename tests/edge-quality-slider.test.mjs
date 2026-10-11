import test from 'node:test';
import assert from 'node:assert/strict';
import {attachEdgeQualitySlider} from '../src/lib/pointcloud/edge-quality-slider.ts';

function surface() {
  const listeners = new Map();
  return {
    innerWidth: 390, innerHeight: 800,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    send(type, {x = 385, y = 300, id = 1, pointerType = 'touch', isPrimary = true, control = false} = {}) {
      const event = {
        pointerType, isPrimary, pointerId: id, clientX: x, clientY: y,
        target: {closest: () => control ? {} : null},
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; }
      };
      listeners.get(type)?.(event);
      return event;
    }
  };
}

test('right-edge vertical drag selects four levels from local to maximum Shadow', () => {
  const screen = surface(), selected = [], active = [];
  const slider = attachEdgeQualitySlider(screen, {onLevel: level => selected.push(level), onActive: (...values) => active.push(values)});
  assert.equal(slider.level, 2);
  assert.equal(screen.send('pointerdown', {y: 790}).prevented, true);
  assert.equal(slider.level, 0);
  screen.send('pointermove', {y: 590});
  screen.send('pointermove', {y: 390});
  screen.send('pointermove', {y: 190});
  screen.send('pointerup', {y: 190});
  assert.deepEqual(selected, [0, 1, 2, 3]);
  assert.deepEqual(active, [[true, 0], [true, 1], [true, 2], [true, 3], [false, 3]]);
  assert.equal(slider.level, 3);
  slider.dispose();
});

test('the narrow edge leaves the viewer, mouse, other touches and access control alone', () => {
  const screen = surface(), selected = [];
  const slider = attachEdgeQualitySlider(screen, {onLevel: level => selected.push(level)});
  for (const input of [
    {x: 360},
    {pointerType: 'mouse'},
    {isPrimary: false},
    {control: true}
  ]) {
    const event = screen.send('pointerdown', input);
    assert.equal(event.prevented, false);
    assert.equal(event.stopped, false);
  }
  assert.deepEqual(selected, []);
  assert.equal(slider.level, 2);
  slider.setLevel(3);
  assert.equal(slider.level, 3);
  assert.deepEqual(selected, []);
  slider.dispose();
});

test('active slider swallows viewer events and releases on cancel or blur', () => {
  const screen = surface(), active = [];
  const slider = attachEdgeQualitySlider(screen, {onLevel() {}, onActive: (...values) => active.push(values)});
  const down = screen.send('pointerdown');
  assert.equal(down.stopped, true);
  assert.equal(screen.send('pointerdown', {id: 2, isPrimary: false, x: 100}).stopped, true);
  assert.equal(screen.send('pointermove', {id: 2, isPrimary: false, x: 100}).stopped, true);
  assert.equal(screen.send('pointermove', {y: 50}).stopped, true);
  assert.equal(screen.send('pointercancel', {y: 50}).stopped, true);
  assert.deepEqual(active.at(-1), [false, 3]);
  assert.equal(screen.send('pointermove', {y: 100}).stopped, false);
  screen.send('pointerdown');
  screen.send('blur');
  assert.deepEqual(active.at(-1), [false, 2]);
  screen.send('pointerdown');
  slider.dispose();
  assert.deepEqual(active.at(-1), [false, 2]);
  assert.equal(screen.send('pointerdown').stopped, false);
});
