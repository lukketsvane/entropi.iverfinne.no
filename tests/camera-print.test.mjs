import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { FrameRecorder } from '../src/lib/pointcloud/recorder.mjs';
import { captureSnapshot } from '../static/pointcloud/panorama.mjs';
import { imageToPointCloud, pointCloudPLY, pointStride } from '../static/pointcloud/math.mjs';
import { WIDTH, PRINTER_NAME, buildPrintJob, joinBytes } from '../src/lib/print/px10-protocol.mjs';
import { PX10Printer } from '../src/lib/print/printer.mjs';

const script = fs.readFileSync('src/routes/+page.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0];
const compiled = ts.transpileModule(script + `
export const harness = {
  beginCapture, endCapture, captureClick, retake, retry,
  get mode(){ return mode; }, get printer(){ return printer; },
  mount(elements){ video=elements.video; finder=elements.finder; cloudHost=elements.cloud; photoInput=elements.input; }
};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const waitFor = async predicate => {
  const until = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

function fixture(withBluetooth = true) {
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
  let mount, cleanup, viewError, generated = 0;
  const track = { stop(){}, readyState: 'live' }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { readyState: 2, videoWidth: 4, videoHeight: 4, srcObject: null, play: async () => {} };
  const document = Object.assign(new EventTarget(), {
    hidden: false, visibilityState: 'visible', createElement: () => ({ width: 4, height: 4, getContext: () => ({
      fillRect(){}, drawImage(){}, putImageData(){}, getImageData: () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(180) })
    }) })
  });
  const window = new EventTarget();
  const modules = {
    svelte: { onMount: callback => { mount = callback; }, tick: async () => {} },
    '$app/state': { updated: { current: false } },
    '../lib/pointcloud/estimator.mjs': { DepthEstimator: class { dispose(){} } },
    '../lib/pointcloud/viewer.mjs': { createPointCloudViewer: (_, cloud, onError) => {
      generated++; assert.ok(cloud.count > 0); viewError = onError;
      return { setStyle(){}, setHeadPose(){}, dispose(){}, snapshot: () => ({ width: 384, height: 2 }) };
    } },
    '../lib/pointcloud/viewfinder.mjs': { Viewfinder: class { clear(){} dispose(){} } },
    '../lib/pointcloud/recorder.mjs': { FrameRecorder },
    '../lib/pointcloud/head-tracker': { HeadTracker: class { start(){} stop(){} } },
    '../lib/print/printer.mjs': { PX10Printer: CameraPrinter },
    '../lib/print/cloud-raster.mjs': { cloudPrintJob: () => paper },
    '../../static/pointcloud/math.mjs': { imageToPointCloud, pointCloudPLY, pointStride },
    '../../static/pointcloud/tiles.mjs': { estimateImageDepth: async () => ({ depth: new Float32Array(16).fill(1), width: 4, height: 4 }) },
    '../../static/pointcloud/panorama.mjs': { captureSnapshot },
    '../lib/pointcloud/studio.css': {}
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => { assert.ok(name in modules, name); return modules[name]; },
    $state: value => value, navigator: { mediaDevices: { getUserMedia: async () => stream } }, document, window,
    setTimeout, clearTimeout, performance, console, URL, Blob, crypto, Uint8Array, Uint8ClampedArray, Float32Array, DOMException,
    ImageData: class { constructor(data, width, height){ Object.assign(this, { data, width, height }); } }
  });
  exports.harness.mount({ video, finder: {}, cloud: {}, input: { click(){} } }); cleanup = mount();
  const event = { isPrimary: true, pointerType: 'touch', pointerId: 1, preventDefault(){}, currentTarget: { setPointerCapture(){} } };
  const tap = () => { exports.harness.beginCapture(event); exports.harness.endCapture(event); exports.harness.captureClick({ detail: 1 }); };
  return { ...exports.harness, harness: exports.harness, tap, requested, writes, paper,
    generated: () => generated, failView: () => viewError(new Error('GPU lost')), cleanup: () => cleanup() };
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
