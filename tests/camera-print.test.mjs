import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { FrameRecorder } from '../src/lib/pointcloud/recorder.mjs';
import { ShakeToClear } from '../src/lib/pointcloud/shake.mjs';
import { captureSnapshot } from '../static/pointcloud/panorama.mjs';
import { imageToPointCloud, pointCloudPLY, pointStride } from '../static/pointcloud/math.mjs';
import { WIDTH, PRINTER_NAME, buildPrintJob, joinBytes } from '../src/lib/print/px10-protocol.mjs';
import { PX10Printer } from '../src/lib/print/printer.mjs';

const script = fs.readFileSync('src/routes/+page.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0];
const compiled = ts.transpileModule(script + `
export const harness = {
  beginCapture, endCapture, captureClick, retake, retry,
  get mode(){ return mode; }, get printer(){ return printer; },
  get draft(){ return captured; }, get download(){ return plyUrl; },
  mount(elements){ video=elements.video; finder=elements.finder; cloudHost=elements.cloud; photoInput=elements.input; }
};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const waitFor = async predicate => {
  const until = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

function fixture(withBluetooth = true, { motionPermission = 'unsupported', depthGate = null } = {}) {
  const writes = [], requested = [], paper = buildPrintJob(new Uint8Array(WIDTH * 2));
  const device = new EventTarget(); device.name = PRINTER_NAME; device.id = 'px10';
  const notifier = new EventTarget(); notifier.startNotifications = async () => notifier;
  const writer = { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: async bytes => { writes.push(bytes.slice()); } };
  const service = { getCharacteristic: async uuid => uuid.includes('ae01') ? writer : notifier };
  device.gatt = { connected: false, connect: async () => { device.gatt.connected = true; return device.gatt; },
    disconnect: () => { device.gatt.connected = false; }, getPrimaryService: async () => service };
  const api = withBluetooth ? { getDevices: async () => [], requestDevice: options => { requested.push(options); return Promise.resolve(device); } } : undefined;
  class CameraPrinter extends PX10Printer {
    constructor(){ super({ bluetooth: () => api, storage: () => undefined, delay: 0 }); }
  }
  let mount, cleanup, viewError, preview, generated = 0, disposedViews = 0, motionTime = 0, motionRequests = 0, stitchedFrames = 0, cameraRequests = 0;
  const track = { stop(){}, readyState: 'live' }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { readyState: 2, videoWidth: 4, videoHeight: 4, srcObject: null, play: async () => {} };
  const document = Object.assign(new EventTarget(), {
    hidden: false, visibilityState: 'visible', createElement: () => ({ width: 4, height: 4, getContext: () => ({
      fillRect(){}, drawImage(){}, putImageData(){}, getImageData: () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(180) })
    }) })
  });
  const window = new EventTarget();
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
    '../lib/pointcloud/viewer.mjs': { createPointCloudViewer: (_, cloud, onError) => {
      generated++; assert.ok(cloud.count > 0); viewError = onError;
      return { setStyle(){}, setHeadPose(){}, dispose(){ disposedViews++; }, snapshot: () => ({ width: 384, height: 2 }) };
    } },
    '../lib/pointcloud/viewfinder.mjs': { Viewfinder: class { constructor(){ preview = this; } clear(){ this.source = null; } dispose(){} } },
    '../lib/pointcloud/recorder.mjs': { FrameRecorder },
    '../lib/pointcloud/shake.mjs': { ShakeToClear: CameraShake },
    '../lib/pointcloud/head-tracker': { HeadTracker: class { start(){} stop(){} } },
    '../lib/print/printer.mjs': { PX10Printer: CameraPrinter },
    '../lib/print/cloud-raster.mjs': { cloudPrintJob: () => paper },
    '../../static/pointcloud/math.mjs': { imageToPointCloud, pointCloudPLY, pointStride },
    '../../static/pointcloud/tiles.mjs': { estimateImageDepth: async () => {
      if (depthGate) await depthGate;
      return { depth: new Float32Array(16).fill(1), width: 4, height: 4 };
    } },
    '../../static/pointcloud/panorama.mjs': { captureSnapshot },
    '../lib/pointcloud/studio.css': {}
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; },
    $state: value => value, navigator: { mediaDevices: { getUserMedia: async () => { cameraRequests++; return stream; } } }, document, window,
    setTimeout, clearTimeout, performance, console, URL, Blob, crypto, ArrayBuffer, Uint8Array, Uint8ClampedArray, Float32Array, DOMException,
    ImageData: class { constructor(data, width, height){ Object.assign(this, { data, width, height }); } },
    Worker: class {
      terminate(){}
      postMessage(frames){ stitchedFrames = frames.length; queueMicrotask(() => this.onmessage({ data: {
        type: 'result', ...frames[0], inputFrames: frames.length, registeredFrames: frames.length
      } })); }
    }
  });
  exports.harness.mount({ video, finder: {}, cloud: {}, input: { click(){} } }); cleanup = mount();
  const event = { isPrimary: true, pointerType: 'touch', pointerId: 1, preventDefault(){}, currentTarget: { setPointerCapture(){} } };
  const tap = () => { exports.harness.beginCapture(event); exports.harness.endCapture(event); exports.harness.captureClick({ detail: 1 }); };
  const shake = () => {
    for (const x of [18, -18, 18]) {
      motionTime += 140;
      window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x, y: 0, z: 0 } }));
    }
  };
  return { ...exports.harness, harness: exports.harness, tap, requested, writes, paper,
    shake, begin: () => exports.harness.beginCapture(event), end: () => {
      exports.harness.endCapture(event); exports.harness.captureClick({ detail: 1 });
    }, motionRequests: () => motionRequests, stitchedFrames: () => stitchedFrames,
    cameraRequests: () => cameraRequests, previewSource: () => preview?.source, video,
    disposedViews: () => disposedViews, generated: () => generated, failView: () => viewError(new Error('GPU lost')), cleanup: () => cleanup() };
}

test('the actual Entropi shutter pairs once, then captures and prints; GPU retry does not print twice', async t => {
  const camera = fixture(); t.after(camera.cleanup);
  camera.tap(); assert.equal(camera.requested.length, 1); assert.equal(camera.generated(), 0);
  await waitFor(() => camera.harness.printer.ready);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && camera.writes.length > 0 && !camera.harness.printer.busy);
  assert.equal(camera.generated(), 1); assert.equal(camera.requested.length, 1);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
  camera.failView(); assert.equal(camera.harness.mode, 'error'); camera.harness.retry();
  await waitFor(() => camera.harness.mode === 'done');
  assert.equal(camera.generated(), 2); assert.deepEqual(joinBytes(camera.writes), camera.paper);
  await camera.harness.retake(); camera.tap();
  await waitFor(() => camera.generated() === 3 && camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.deepEqual(joinBytes(camera.writes), joinBytes([camera.paper, camera.paper]));
  assert.equal(camera.requested.length, 1);
});

test('without an active extension the same shutter still creates a cloud, without a Bluetooth prompt', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  assert.equal(camera.requested.length, 0); assert.equal(camera.generated(), 1); assert.equal(camera.writes.length, 0);
});

test('holding the actual shutter prints one panorama on release', async t => {
  const camera = fixture(); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.begin(); await waitFor(() => camera.harness.mode === 'recording');
  assert.equal(camera.writes.length, 0); camera.end();
  await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.ok(camera.stitchedFrames() >= 3); assert.equal(camera.generated(), 1);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('shake clears the displayed cloud, while a committed print survives clearing', async t => {
  const camera = fixture(true, { motionPermission: 'direct' }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.harness.printer.suspend();
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  assert.equal(camera.harness.printer.queue.length, 1); assert.equal(camera.writes.length, 0);
  camera.shake(); assert.equal(camera.harness.mode, 'camera'); assert.equal(camera.disposedViews(), 1);
  assert.equal(camera.harness.draft, null); assert.equal(camera.harness.download, ''); assert.equal(camera.previewSource(), null);
  await waitFor(() => camera.previewSource() === camera.video);
  assert.equal(camera.harness.printer.queue.length, 1);
  await camera.harness.printer.start(); await waitFor(() => camera.writes.length && !camera.harness.printer.busy);
  assert.deepEqual(joinBytes(camera.writes), camera.paper);
  camera.shake(); assert.equal(camera.harness.mode, 'camera'); assert.equal(camera.disposedViews(), 1);
});

test('shake aborts a held draft and its release does not capture or print it', async t => {
  const camera = fixture(true, { motionPermission: 'direct' }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.begin(); await waitFor(() => camera.harness.mode === 'recording');
  camera.shake(); assert.equal(camera.harness.mode, 'camera'); camera.end();
  assert.equal(camera.generated(), 0); assert.equal(camera.writes.length, 0);
  await waitFor(() => camera.cameraRequests() >= 2 && camera.previewSource() === camera.video);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.equal(camera.generated(), 1); assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('shake during depth inference prevents a late result or print from returning', async t => {
  let resolve;
  const depthGate = new Promise(done => { resolve = done; });
  const camera = fixture(true, { motionPermission: 'direct', depthGate }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.tap(); await waitFor(() => camera.harness.mode === 'working');
  camera.shake(); assert.equal(camera.harness.mode, 'camera'); resolve();
  await new Promise(done => setTimeout(done, 10));
  assert.equal(camera.generated(), 0); assert.equal(camera.writes.length, 0);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.equal(camera.generated(), 1); assert.deepEqual(joinBytes(camera.writes), camera.paper);
});

test('the same invisible shutter handles Bluetooth and iOS motion permission once before printing', async t => {
  const camera = fixture(true, { motionPermission: 'granted' }); t.after(camera.cleanup);
  camera.tap(); assert.equal(camera.requested.length, 1); assert.equal(camera.motionRequests(), 0);
  await waitFor(() => camera.harness.printer.ready);
  camera.tap(); assert.equal(camera.motionRequests(), 1); assert.equal(camera.generated(), 0);
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
