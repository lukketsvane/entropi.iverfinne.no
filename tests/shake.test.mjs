import test from 'node:test';
import assert from 'node:assert/strict';
import { ShakeDetector, ShakeToClear } from '../src/lib/pointcloud/shake.mjs';

const motion = (x = 0, y = 0, z = 0) => ({ acceleration: { x, y, z } });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('a deliberate shake clears on each axis, once per burst', () => {
  for (let axis = 0; axis < 3; axis++) {
    const detector = new ShakeDetector();
    const sample = strength => { const v = [0, 0, 0]; v[axis] = strength; return motion(...v); };
    assert.equal(detector.sample(sample(18), 0), false);
    assert.equal(detector.sample(sample(-18), 140), false);
    assert.equal(detector.sample(sample(18), 280), true);
    for (let time = 360; time < 1400; time += 80) assert.equal(detector.sample(sample(time % 160 ? -20 : 20), time), false);
    assert.equal(detector.sample(sample(18), 1600), false);
    assert.equal(detector.sample(sample(-18), 1740), false);
    assert.equal(detector.sample(sample(18), 1880), true);
  }
});

test('panning, walking, slow rotation, a single knock and sensor jitter keep the draft', () => {
  const detector = new ShakeDetector();
  for (let frame = 0; frame < 200; frame++) {
    const angle = frame * Math.PI / 180;
    assert.equal(detector.sample({ acceleration: null, accelerationIncludingGravity: {
      x: 9.81 * Math.sin(angle), y: 0, z: 9.81 * Math.cos(angle)
    } }, frame * 20), false);
  }
  for (let frame = 0; frame < 100; frame++) assert.equal(detector.sample(motion(4 * Math.sin(frame)), 5000 + frame * 30), false);
  detector.reset();
  assert.equal(detector.sample(motion(22), 9000), false);
  assert.equal(detector.sample(motion(-5), 9100), false);
  assert.equal(detector.sample(motion(2), 9200), false);
  detector.reset();
  assert.equal(detector.sample(motion(20), 10000), false);
  assert.equal(detector.sample(motion(-20), 10010), false);
  assert.equal(detector.sample(motion(20), 10020), false);
  assert.equal(detector.sample(motion(-20), 10030), false);
});

test('gravity-only acceleration works without treating stationary gravity as a shake', () => {
  const detector = new ShakeDetector();
  const sample = x => ({ acceleration: { x: null, y: null, z: null }, accelerationIncludingGravity: { x, y: 0, z: 9.81 } });
  assert.equal(detector.sample(sample(0), 0), false);
  assert.equal(detector.sample(sample(24), 100), false);
  assert.equal(detector.sample(sample(-24), 240), false);
  assert.equal(detector.sample(sample(24), 380), true);
});

test('missing sensor data and long gaps cannot combine unrelated jolts', () => {
  const detector = new ShakeDetector();
  assert.equal(detector.sample(motion(18), 0), false);
  assert.equal(detector.sample(motion(-18), 500), false);
  assert.equal(detector.sample(motion(18), 1000), false);
  assert.equal(detector.sample(motion(NaN), 1100), false);
  assert.equal(detector.sample(motion(-18), 1200), false);
  assert.equal(detector.sample(motion(18), 1340), false);
});

function controller(permission) {
  const target = new EventTarget();
  let requests = 0, clears = 0, draft = true, time = 0;
  target.DeviceMotionEvent = permission === undefined ? {} : { requestPermission: () => {
    requests++; return typeof permission === 'function' ? permission() : Promise.resolve(permission);
  } };
  const shake = new ShakeToClear({ target, hasDraft: () => draft, clear: () => { clears++; }, now: () => time });
  const send = (x, at) => {
    time = at;
    const event = Object.assign(new Event('devicemotion'), motion(x));
    target.dispatchEvent(event);
  };
  return { shake, send, requests: () => requests, clears: () => clears, draft: value => { draft = value; } };
}

test('iOS permission is requested synchronously by one gesture, never by mounting', async t => {
  const c = controller('granted'); t.after(() => c.shake.dispose());
  c.shake.start(); assert.equal(c.requests(), 0);
  c.send(18, 0); c.send(-18, 140); c.send(18, 280); assert.equal(c.clears(), 0);
  assert.equal(c.shake.requestFromGesture(), true); assert.equal(c.requests(), 1);
  assert.equal(c.shake.requestFromGesture(), true); assert.equal(c.requests(), 1);
  await flush(); assert.equal(c.shake.requestFromGesture(), false);
  c.send(18, 1000); c.send(-18, 1140); c.send(18, 1280); assert.equal(c.clears(), 1);
});

test('denied and failed permissions leave other gestures usable and never prompt repeatedly', async t => {
  for (const permission of ['denied', () => Promise.reject(new Error('NotAllowedError')), () => { throw new Error('Blocked'); }]) {
    const c = controller(permission); t.after(() => c.shake.dispose()); c.shake.start();
    assert.equal(c.shake.requestFromGesture(), true); await flush();
    assert.equal(c.shake.requestFromGesture(), false); assert.equal(c.requests(), 1);
    c.send(18, 0); c.send(-18, 140); c.send(18, 280); assert.equal(c.clears(), 0);
  }
});

test('idle, background and disposed controllers cannot clear a new draft', async t => {
  const c = controller(); t.after(() => c.shake.dispose()); c.shake.start();
  c.draft(false); c.send(18, 0); c.send(-18, 140);
  c.draft(true); c.send(18, 280); assert.equal(c.clears(), 0);
  c.shake.suspend(); c.send(-18, 420); c.send(18, 560); assert.equal(c.clears(), 0);
  c.shake.start(); c.send(18, 700); c.send(-18, 840); assert.equal(c.clears(), 0);
  c.send(18, 980); assert.equal(c.clears(), 1);
  c.shake.dispose(); c.send(18, 2500); c.send(-18, 2640); c.send(18, 2780); assert.equal(c.clears(), 1);

  let grant;
  const late = controller(() => new Promise(resolve => { grant = resolve; }));
  late.shake.start(); late.shake.requestFromGesture(); late.shake.dispose(); grant('granted'); await flush();
  assert.equal(late.shake.listening, false);
});

test('devices without motion support require no setup gesture', () => {
  const shake = new ShakeToClear({ target: new EventTarget(), hasDraft: () => true, clear: () => assert.fail('Unsupported sensor cleared') });
  shake.start(); assert.equal(shake.requestFromGesture(), false); assert.equal(shake.listening, false); shake.dispose();
});
