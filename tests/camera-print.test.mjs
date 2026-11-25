import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { FrameRecorder } from '../src/lib/pointcloud/recorder.mjs';
import { ShakeToClear } from '../src/lib/pointcloud/shake.mjs';
import { captureSnapshot } from '../static/pointcloud/panorama.mjs';
import { WIDTH, PRINTER_NAME, buildPrintJob, joinBytes } from '../src/lib/print/px10-protocol.mjs';
import { PX10Printer } from '../src/lib/print/printer.mjs';
import * as vathography from '../src/lib/vathography.mjs';

const script = fs.readFileSync('src/routes/+page.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0];
const compiled = ts.transpileModule(script + `
export const harness = {
  beginCapture, endCapture, captureClick, retake, retry, artDown, artMove, artUp, selectPreset,
  get mode(){ return mode; }, get printer(){ return printer; }, get announcement(){ return announcement; },
  get preset(){ return preset; }, get position(){ return position; }, get bandWidth(){ return bandWidth; }, get draft(){ return captured; },
  mount(elements){ video=elements.video; finder=elements.finder; art=elements.art; photoInput=elements.input; }
};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const waitFor = async predicate => {
  const until = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

function fixture(withBluetooth = true, { motionPermission = 'unsupported', depthGate = null, depthError = null, changingFrames = false, storage = null } = {}) {
  const writes = [], requested = [], paints = [], paper = buildPrintJob(new Uint8Array(WIDTH * 2));
  const device = new EventTarget(); device.name = PRINTER_NAME; device.id = 'px10';
  const notifier = new EventTarget(); notifier.startNotifications = async () => notifier;
  const writer = { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: async bytes => { writes.push(bytes.slice()); } };
  const service = { getCharacteristic: async uuid => uuid.includes('ae01') ? writer : notifier };
  device.gatt = { connected: false, connect: async () => { device.gatt.connected = true; return device.gatt; },
    disconnect: () => { device.gatt.connected = false; }, getPrimaryService: async () => service };
  const bluetooth = { getDevices: async () => [], requestDevice: options => { requested.push(options); return Promise.resolve(device); } };
  let api = withBluetooth ? bluetooth : undefined;
  class CameraPrinter extends PX10Printer {
    constructor(){ super({ bluetooth: () => api, storage: () => undefined, delay: 0 }); }
  }
  let mount, cleanup, preview, motionTime = 0, motionRequests = 0, stitchedFrames = 0, cameraRequests = 0, pointerTime = 0, samples = 0, estimates = 0;
  const sliders = new Map();
  const track = { stop(){}, readyState: 'live' }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { readyState: 2, videoWidth: 4, videoHeight: 4, srcObject: null, play: async () => {} };
  const art = { width: 1, height: 1, clientWidth: 100, getContext: () => ({ putImageData(image){ paints.push(image); } }) };
  const document = Object.assign(new EventTarget(), {
    hidden: false, visibilityState: 'visible', createElement: () => ({ width: 4, height: 4, getContext: () => ({
      fillRect(){}, drawImage(){}, putImageData(){}, getImageData: () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(changingFrames ? 100 + (++samples) * 10 : 180) })
    }) })
  });
  const window = new EventTarget();
  if (storage) window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  if (motionPermission !== 'unsupported') window.DeviceMotionEvent = motionPermission === 'direct' ? {} : {
    requestPermission: () => { motionRequests++; return Promise.resolve(motionPermission); }
  };
  class CameraShake extends ShakeToClear {
    constructor(options){ super({ ...options, now: () => motionTime }); }
  }
  const modules = {
    svelte: { onMount: callback => { mount = callback; }, tick: async () => {} },
    '$app/state': { updated: { current: false } },
    '../lib/pointcloud/estimator.mjs': { DepthEstimator: class { dispose(){} } },
    '../lib/pointcloud/edge-quality-slider': { attachEdgeQualitySlider: (_surface, options) => {
      const slider = {options, level: options.initialLevel, setLevel(level){ this.level = level; }, select(level){ options.onLevel(level); }, dispose(){}};
      sliders.set(options.edge ?? 'right', slider);
      return slider;
    } },
    '../lib/pointcloud/viewfinder.mjs': { Viewfinder: class { constructor(){ preview = this; } clear(){ this.source = null; } dispose(){} } },
    '../lib/pointcloud/recorder.mjs': { FrameRecorder },
    '../lib/pointcloud/shake.mjs': { ShakeToClear: CameraShake },
    '../lib/print/printer.mjs': { PX10Printer: CameraPrinter },
    '../lib/print/cloud-raster.mjs': { artPrintJob: source => { assert.equal(source, art); return paper; } },
    '../lib/vathography.mjs': vathography,
    '../../static/pointcloud/tiles.mjs': { estimateImageDepth: async () => {
      if (depthGate) await depthGate;
      estimates++;
      if (depthError) { const error = depthError; depthError = null; throw error; }
      return { depth: Float32Array.from({ length: 16 }, (_, i) => i), width: 4, height: 4 };
    } },
    '../../static/pointcloud/panorama.mjs': { captureSnapshot },
    '../lib/pointcloud/studio.css': {}
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; },
    $state: value => value, navigator: { mediaDevices: { getUserMedia: async () => { cameraRequests++; return stream; } } }, document, window,
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    performance: {now: () => pointerTime}, console: {...console, warn(){}}, URL, Blob, crypto, ArrayBuffer, Uint8Array, Uint8ClampedArray, Float32Array, DOMException, AbortController,
    ImageData: class { constructor(data, width, height){ Object.assign(this, { data, width, height }); } },
    Worker: class {
      terminate(){}
      postMessage(frames){ stitchedFrames = frames.length; queueMicrotask(() => this.onmessage({ data: {
        type: 'result', ...frames[0], inputFrames: frames.length, registeredFrames: frames.length
      } })); }
    }
  });
  exports.harness.mount({ video, finder: {}, art, input: { click(){} } }); cleanup = mount();
  const event = { isPrimary: true, pointerType: 'touch', pointerId: 1, preventDefault(){}, currentTarget: { setPointerCapture(){} } };
  const tap = () => { exports.harness.beginCapture(event); exports.harness.endCapture(event); exports.harness.captureClick({ detail: 1 }); };
  const shake = () => {
    for (const x of [18, -18, 18]) {
      motionTime += 140;
      window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x, y: 0, z: 0 } }));
    }
  };
  const point = (pointerId, clientX, clientY = 200, isPrimary = pointerId === 1) => ({ pointerId, clientX, clientY, isPrimary });
  return { harness: exports.harness, tap, requested, writes, paper, paints, art, slider: edge => sliders.get(edge),
    enableBluetooth: () => { api = bluetooth; }, advancePointer: ms => { pointerTime += ms; }, point,
    holdResult: (move = 0) => {
      exports.harness.artDown(point(1, 100));
      if (move) exports.harness.artMove(point(1, 100 + move));
      pointerTime += 600; exports.harness.artUp(point(1, 100 + move));
    },
    shake, begin: () => exports.harness.beginCapture(event), end: () => {
      exports.harness.endCapture(event); exports.harness.captureClick({ detail: 1 });
    }, motionRequests: () => motionRequests, stitchedFrames: () => stitchedFrames, estimates: () => estimates,
    cameraRequests: () => cameraRequests, previewSource: () => preview?.source, video, cleanup: () => cleanup() };
}
const grey = image => Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4]);

test('the shutter pairs once, then develops a depth lithograph from Depth Pro 2 and prints it', async t => {
  const camera = fixture(); t.after(camera.cleanup);
  camera.tap(); assert.equal(camera.requested.length, 1); assert.equal(camera.estimates(), 0);
  await waitFor(() => camera.harness.printer.ready);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && camera.writes.length > 0 && !camera.harness.printer.busy);
  assert.equal(camera.estimates(), 1); assert.equal(camera.requested.length, 1);
  const image = camera.paints.at(-1);
  assert.deepEqual([image.width, image.height, camera.art.width, camera.art.height], [4, 4, 4, 4]);
  for (let i = 0; i < image.data.length; i += 4) assert.ok(image.data[i] === image.data[i + 1] && image.data[i] === image.data[i + 2] && image.data[i + 3] === 255);
  assert.ok(new Set(grey(image)).size > 4, 'Depth becomes a tonal image, not a flat field');
  assert.match(camera.harness.announcement, /Depth Pro 2/);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
  await camera.harness.retake(); camera.tap();
  await waitFor(() => camera.estimates() === 2 && camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.deepEqual(joinBytes(camera.writes), joinBytes([camera.paper, camera.paper]));
});

test('without an active extension the same shutter still develops the image, without a Bluetooth prompt', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  assert.equal(camera.requested.length, 0); assert.equal(camera.estimates(), 1); assert.equal(camera.writes.length, 0);
});

test('enabling Bluetooth after capture allows holding the existing result to pair and print', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  camera.enableBluetooth(); camera.holdResult();
  assert.equal(camera.requested.length, 1, 'Chooser is called in the actual pointerup gesture');
  await waitFor(() => camera.writes.length && !camera.harness.printer.busy);
  assert.equal(camera.estimates(), 1); assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('a horizontal drag moves the depth band without printing or another inference', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  const before = grey(camera.paints.at(-1));
  camera.enableBluetooth(); camera.holdResult(40);
  await waitFor(() => camera.paints.length > 1);
  assert.ok(Math.abs(camera.harness.position - .4) < 1e-6);
  assert.notDeepEqual(grey(camera.paints.at(-1)), before);
  assert.equal(camera.requested.length, 0); assert.equal(camera.writes.length, 0); assert.equal(camera.estimates(), 1);
});

test('a two-finger pinch changes the band width and cannot become a long-press print', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  camera.enableBluetooth();
  const { harness, point } = camera;
  harness.artDown(point(1, 100)); harness.artDown(point(2, 200));
  harness.artMove(point(2, 300)); camera.advancePointer(600);
  harness.artUp(point(2, 300)); harness.artUp(point(1, 100));
  assert.equal(harness.bandWidth, 2);
  await waitFor(() => camera.paints.length > 1);
  assert.equal(camera.requested.length, 0); assert.equal(camera.writes.length, 0);
});

test('the right edge selects five expressions, repaints without inference and is remembered', async t => {
  const storage = new Map();
  const camera = fixture(false, { storage }); t.after(camera.cleanup);
  const slider = camera.slider('right');
  assert.equal(slider.options.levels, 5); assert.equal(camera.harness.preset, 1);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  const images = new Set([grey(camera.paints.at(-1)).join()]);
  for (const level of [0, 2, 3, 4]) {
    const count = camera.paints.length; slider.select(level);
    await waitFor(() => camera.paints.length > count);
    images.add(grey(camera.paints.at(-1)).join());
  }
  assert.equal(images.size, 5); assert.equal(camera.estimates(), 1);
  assert.equal(storage.get('entropi-vatho'), '4'); assert.equal(slider.level, 4);
  const next = fixture(false, { storage }); t.after(next.cleanup);
  assert.equal(next.harness.preset, 4); assert.equal(next.slider('right').level, 4);
});

test('a failed depth estimate keeps the photo and retry develops it without a new capture', async t => {
  const camera = fixture(false, { depthError: new Error('Kunne ikkje berekne djupna.') }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'error');
  assert.ok(camera.harness.draft); assert.equal(camera.paints.length, 0);
  camera.harness.retry(); await waitFor(() => camera.harness.mode === 'done');
  assert.equal(camera.estimates(), 2); assert.equal(camera.cameraRequests(), 1);
});

test('double tapping the result returns to a live camera', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  for (const time of [0, 100]) { camera.advancePointer(time); camera.harness.artDown(camera.point(1, 100)); camera.advancePointer(50); camera.harness.artUp(camera.point(1, 100)); }
  await waitFor(() => camera.harness.mode === 'camera' && camera.previewSource() === camera.video);
  assert.equal(camera.harness.draft, null);
});

test('holding the actual shutter develops and prints one panorama on release', async t => {
  const camera = fixture(); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.begin(); await waitFor(() => camera.harness.mode === 'recording');
  assert.equal(camera.writes.length, 0); camera.end();
  await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.ok(camera.stitchedFrames() >= 3); assert.equal(camera.estimates(), 1);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('shake clears the displayed image, while a committed print survives clearing', async t => {
  const camera = fixture(true, { motionPermission: 'direct' }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  const start = camera.harness.printer.start.bind(camera.harness.printer);
  camera.harness.printer.start = () => Promise.resolve(false);
  camera.harness.printer.suspend();
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  assert.equal(camera.harness.printer.queue.length, 1); assert.equal(camera.writes.length, 0);
  camera.shake(); assert.equal(camera.harness.mode, 'camera');
  assert.equal(camera.harness.draft, null); assert.equal(camera.previewSource(), null);
  await waitFor(() => camera.previewSource() === camera.video);
  assert.equal(camera.harness.printer.queue.length, 1);
  camera.harness.printer.start = start;
  await camera.harness.printer.start(); await waitFor(() => camera.writes.length && !camera.harness.printer.busy);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('shake aborts a held draft and its release does not capture or print it', async t => {
  const camera = fixture(true, { motionPermission: 'direct' }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.begin(); await waitFor(() => camera.harness.mode === 'recording');
  camera.shake(); assert.equal(camera.harness.mode, 'camera'); camera.end();
  assert.equal(camera.estimates(), 0); assert.equal(camera.writes.length, 0);
  await waitFor(() => camera.cameraRequests() >= 2 && camera.previewSource() === camera.video);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.equal(camera.estimates(), 1); assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('shake during depth inference prevents a late result or print from returning', async t => {
  let resolve;
  const depthGate = new Promise(done => { resolve = done; });
  const camera = fixture(true, { motionPermission: 'direct', depthGate }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.tap(); await waitFor(() => camera.harness.mode === 'working');
  camera.shake(); assert.equal(camera.harness.mode, 'camera'); resolve();
  await new Promise(done => setTimeout(done, 10));
  assert.equal(camera.paints.length, 0); assert.equal(camera.writes.length, 0);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.equal(camera.paints.length, 1); assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('the same invisible shutter handles Bluetooth and iOS motion permission once before printing', async t => {
  const camera = fixture(true, { motionPermission: 'granted' }); t.after(camera.cleanup);
  camera.tap(); assert.equal(camera.requested.length, 1); assert.equal(camera.motionRequests(), 0);
  await waitFor(() => camera.harness.printer.ready);
  camera.tap(); assert.equal(camera.motionRequests(), 1); assert.equal(camera.estimates(), 0);
  await new Promise(done => setTimeout(done, 0));
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
  camera.shake(); assert.equal(camera.harness.mode, 'camera');
});

test('denied motion permission still permits tap capture and printing without another prompt', async t => {
  const camera = fixture(true, { motionPermission: 'denied' }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.tap(); await new Promise(done => setTimeout(done, 0));
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  camera.shake(); assert.equal(camera.harness.mode, 'done'); assert.equal(camera.motionRequests(), 1);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
});
