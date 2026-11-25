import test from 'node:test';
import assert from 'node:assert/strict';
import {attachEdgeQualitySlider} from '../src/lib/pointcloud/edge-quality-slider.ts';

function surface() {
  const listeners = new Map();
  return {
    innerWidth: 390, innerHeight: 800,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    send(type, {x = 385, y = 300, id = 1, pointerType = 'touch', isPrimary = true, control = false} = {}) {
      const event = {
        pointerType, isPrimary, pointerId: id, clientX: x, clientY: y,
        target: {closest: () => control ? {} : null},
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; }
      };
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
        if (event.stopped) break;
      }
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
    {x: 391},
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
  // The secondary finger never reached the viewer; its remaining events must
  // stay suppressed even after the controlling finger has been cancelled.
  assert.equal(screen.send('pointermove', {id: 2, isPrimary: false, x: 100}).stopped, true);
  assert.equal(screen.send('pointerup', {id: 2, isPrimary: false, x: 100}).stopped, true);
  assert.equal(screen.send('pointermove', {y: 100}).stopped, false);
  screen.send('pointerdown');
  screen.send('blur');
  assert.deepEqual(active.at(-1), [false, 2]);
  screen.send('pointerdown');
  slider.dispose();
  assert.deepEqual(active.at(-1), [false, 2]);
  assert.equal(screen.send('pointerdown').stopped, false);
});

test('the left rail mirrors the right rail without changing levels on the other side', () => {
  const screen = surface(), leftLevels = [], rightLevels = [];
  const right = attachEdgeQualitySlider(screen, {initialLevel: 2, onLevel: level => rightLevels.push(level)});
  const left = attachEdgeQualitySlider(screen, {edge: 'left', initialLevel: 0, onLevel: level => leftLevels.push(level)});
  assert.equal(screen.listenerCount('pointerdown'), 1);
  assert.equal(screen.send('pointerdown', {x: 5, y: 10}).stopped, true);
  screen.send('pointermove', {x: 200, y: 210});
  screen.send('pointermove', {x: 200, y: 410});
  screen.send('pointermove', {x: 200, y: 810});
  screen.send('pointerup', {x: 200, y: 810});
  assert.deepEqual(leftLevels, [3, 2, 1, 0]);
  assert.deepEqual(rightLevels, []);
  assert.equal(right.level, 2);
  screen.send('pointerdown', {x: 385, y: 0});
  screen.send('pointerup');
  assert.deepEqual(rightLevels, [3]);
  assert.equal(left.level, 0);
  for (const x of [-1, 28, 200]) assert.equal(screen.send('pointerdown', {x}).stopped, false);
  left.dispose(); right.dispose();
  assert.equal(screen.listenerCount('pointerdown'), 0);
});

for (const firstEdge of ['left', 'right']) {
  test(`overlapping opposite-edge touches keep ownership with the ${firstEdge} rail until all fingers release`, () => {
    const screen = surface(), levels = {left: [], right: []}, active = {left: [], right: []};
    const left = attachEdgeQualitySlider(screen, {edge: 'left', initialLevel: 0,
      onLevel: level => levels.left.push(level), onActive: value => active.left.push(value)});
    const right = attachEdgeQualitySlider(screen, {initialLevel: 0,
      onLevel: level => levels.right.push(level), onActive: value => active.right.push(value)});
    const firstX = firstEdge === 'left' ? 5 : 385;
    const secondX = firstEdge === 'left' ? 385 : 5;
    const secondEdge = firstEdge === 'left' ? 'right' : 'left';
    screen.send('pointerdown', {x: firstX, y: 0});
    assert.equal(screen.send('pointerdown', {x: secondX, y: 0, id: 2, isPrimary: false}).stopped, true);
    assert.equal(screen.send('pointermove', {x: secondX, y: 600, id: 2, isPrimary: false}).stopped, true);
    assert.deepEqual(levels[firstEdge], [3]);
    assert.deepEqual(levels[secondEdge], []);
    assert.equal(screen.send('pointerup', {x: firstX}).stopped, true);
    assert.deepEqual(active[firstEdge], [true, false]);
    assert.equal(screen.send('pointermove', {x: secondX, id: 2, isPrimary: false}).stopped, true);
    assert.equal(screen.send('pointercancel', {x: secondX, id: 2, isPrimary: false}).stopped, true);
    assert.equal(screen.send('pointermove', {x: 200, id: 2, isPrimary: false}).stopped, false);
    screen.send('pointerdown', {x: secondX, y: 0, id: 3});
    screen.send('pointerup', {x: secondX, id: 3});
    assert.deepEqual(levels[secondEdge], [3]);
    assert.deepEqual(active[secondEdge], [true, false]);
    left.dispose(); right.dispose();
  });
}

test('disposing one rail releases it while keeping the other rail and touch cleanup working', () => {
  const screen = surface(), active = [];
  const right = attachEdgeQualitySlider(screen, {onLevel() {}});
  const left = attachEdgeQualitySlider(screen, {edge: 'left', onLevel() {}, onActive: value => active.push(value)});
  screen.send('pointerdown', {x: 5});
  left.dispose(); left.dispose();
  assert.deepEqual(active, [true, false]);
  assert.equal(screen.listenerCount('pointerdown'), 1);
  assert.equal(screen.send('pointerup', {x: 5}).stopped, true);
  assert.equal(screen.send('pointerdown', {x: 5}).stopped, false);
  assert.equal(screen.send('pointerdown').stopped, true);
  screen.send('blur');
  assert.equal(screen.send('pointermove').stopped, false);
  assert.equal(screen.send('pointerdown').stopped, true);
  right.dispose();
  assert.equal(screen.listenerCount('pointerdown'), 0);
  assert.equal(screen.send('pointerup').stopped, false);
});

test('left edge preserves primary touch and accessible control exclusions', () => {
  const screen = surface();
  const left = attachEdgeQualitySlider(screen, {edge: 'left', onLevel() {}});
  for (const input of [{pointerType: 'mouse'}, {pointerType: 'pen'}, {isPrimary: false}, {control: true}]) {
    assert.equal(screen.send('pointerdown', {x: 5, ...input}).stopped, false);
  }
  screen.innerWidth = 200;
  assert.equal(screen.send('pointerdown', {x: 24}).stopped, true);
  screen.send('pointerup');
  assert.equal(screen.send('pointerdown', {x: 25}).stopped, false);
  left.dispose();
});

test('a rail with five levels maps the full edge height to five choices', () => {
  const screen = surface(), selected = [];
  const slider = attachEdgeQualitySlider(screen, {levels: 5, initialLevel: 1, onLevel: level => selected.push(level)});
  for (const y of [799, 600, 400, 200, 0]) screen.send(y === 799 ? 'pointerdown' : 'pointermove', {y});
  screen.send('pointerup', {y: 0});
  assert.deepEqual(selected, [0, 1, 2, 3, 4]);
  assert.equal(slider.level, 4);
  slider.dispose();
});
