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
import { createGallery } from '../src/lib/gallery.mjs';
import { memoryIndexedDB } from './helpers/indexeddb.mjs';

const script = fs.readFileSync('src/routes/+page.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0];
const compiled = ts.transpileModule(script + `
export const harness = {
  beginCapture, endCapture, captureClick, retake, retry, artDown, artMove, artUp, selectPreset, openGallery, closeGallery, openItem, keys, uploadToGallery, tileDown, tileMove, cancelPress, tileClick, saveMenu, shareMenu, deleteMenu,
  get menu(){ return menu; }, get contrast(){ return contrast; }, get gamma(){ return gamma; },
  get uploading(){ return uploading; },
  get galleryOpen(){ return galleryOpen; }, get galleryItems(){ return galleryItems; }, get currentId(){ return currentId; },
  get mode(){ return mode; }, get printer(){ return printer; }, get announcement(){ return announcement; },
  get preset(){ return preset; }, get position(){ return position; }, get bandWidth(){ return bandWidth; }, get draft(){ return captured; },
  mount(elements){ video=elements.video; finder=elements.finder; art=elements.art; photoInput=elements.input; }
};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const waitFor = async predicate => {
  const until = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 2)); }
};

function fixture(withBluetooth = true, { motionPermission = 'unsupported', depthGate = null, depthError = null, changingFrames = false, storage = null, database = memoryIndexedDB(), share = null } = {}) {
  const downloads = [], shared = [];
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
    hidden: false, visibilityState: 'visible', createElement: () => ({ width: 4, height: 4, click(){ downloads.push(this); }, toBlob: callback => callback(new Blob(['thumbnail'])), getContext: () => ({
      fillRect(){}, drawImage(){}, putImageData(){}, getImageData: () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(changingFrames ? 100 + (++samples) * 10 : 180) })
    }) })
  });
  const window = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 844 });
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
    '../lib/gallery.mjs': { createGallery: () => createGallery(database ?? undefined) },
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
    $state: value => value, navigator: { mediaDevices: { getUserMedia: async () => { cameraRequests++; return stream; } }, ...(share ? { share: async data => { shared.push(data); }, canShare: share } : {}) }, document, window, File,
    createImageBitmap: async file => { if ((await file.text()).startsWith('broken')) throw new Error('unsupported'); return { width: 8, height: 6, close(){} }; },
    Image: class { decode(){ return Promise.reject(new Error('undecodable')); } },
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
  return { harness: exports.harness, tap, downloads, shared, requested, writes, paper, paints, art, slider: edge => sliders.get(edge),
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

test('each developed image is kept in the gallery grid and reopens with its expression, without the model', async t => {
  const database = memoryIndexedDB();
  const camera = fixture(false, { database }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && camera.harness.currentId);
  const count = camera.paints.length; camera.slider('right').select(3);
  await waitFor(() => camera.paints.length > count);
  const chosen = grey(camera.paints.at(-1));
  await camera.harness.retake(); assert.equal(camera.harness.mode, 'camera');
  await camera.harness.openGallery();
  assert.equal(camera.harness.galleryOpen, true); assert.equal(camera.harness.galleryItems.length, 1);
  assert.match(camera.harness.galleryItems[0].url, /^blob:/);
  await camera.harness.openItem(camera.harness.galleryItems[0].id);
  assert.equal(camera.harness.mode, 'done'); assert.equal(camera.harness.galleryOpen, false);
  assert.equal(camera.harness.preset, 3); assert.equal(camera.slider('right').level, 3);
  assert.deepEqual(grey(camera.paints.at(-1)), chosen);
  assert.equal(camera.estimates(), 1); assert.equal(camera.writes.length, 0);
  const next = fixture(false, { database }); t.after(next.cleanup);
  await next.harness.openGallery(); assert.equal(next.harness.galleryItems.length, 1);
});

test('the gallery opened from the camera closes back to a live camera, and Escape closes it first', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  await waitFor(() => camera.previewSource() === camera.video);
  await camera.harness.openGallery();
  assert.equal(camera.harness.galleryOpen, true); assert.equal(camera.previewSource(), null);
  assert.match(camera.harness.announcement, /tomt/);
  camera.harness.keys({ key: 'Escape' });
  assert.equal(camera.harness.galleryOpen, false); assert.equal(camera.harness.mode, 'camera');
  await waitFor(() => camera.previewSource() === camera.video && camera.cameraRequests() === 2);
});

test('without local storage the camera still develops and prints, and the gallery says it is unavailable', async t => {
  const camera = fixture(true, { database: null }); t.after(camera.cleanup);
  camera.tap(); await waitFor(() => camera.harness.printer.ready);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.printer.busy);
  assert.deepEqual(joinBytes(camera.writes), camera.paper); assert.equal(camera.harness.currentId, null);
  await camera.harness.openGallery();
  assert.match(camera.harness.announcement, /ikkje tilgjengeleg/);
  camera.harness.closeGallery(); assert.equal(camera.harness.mode, 'done');
});

const files = (...names) => ({ currentTarget: { files: names.map(name => new File([name], name, { type: 'image/jpeg' })), value: 'x' } });

test('several photos uploaded in the gallery each become their own depth image in the grid', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  await camera.harness.openGallery();
  camera.harness.uploadToGallery(files('a.jpg', 'b.jpg', 'c.jpg'));
  await waitFor(() => camera.harness.uploading === 0 && camera.harness.galleryItems.length === 3);
  assert.equal(camera.estimates(), 3); assert.equal(camera.stitchedFrames(), 0);
  assert.equal(camera.harness.mode, 'camera'); assert.equal(camera.paints.length, 0);
  assert.match(camera.harness.announcement, /3 opplasta bilete/);
  await camera.harness.openItem(camera.harness.galleryItems[2].id);
  assert.equal(camera.harness.mode, 'done'); assert.equal(camera.estimates(), 3);
});

test('an unreadable upload is skipped and reported while the rest are kept', async t => {
  const camera = fixture(false); t.after(camera.cleanup);
  await camera.harness.openGallery();
  camera.harness.uploadToGallery(files('a.jpg', 'broken.heic', 'c.jpg'));
  await waitFor(() => camera.harness.uploading === 0 && camera.harness.galleryItems.length === 2);
  assert.match(camera.harness.announcement, /2 opplasta bilete.*1 kunne ikkje lesast/);
});

test('uploads keep developing after the gallery closes and a photo is taken, and a photo goes first', async t => {
  let resolve;
  const depthGate = new Promise(done => { resolve = done; });
  const database = memoryIndexedDB();
  const camera = fixture(false, { depthGate, database }); t.after(camera.cleanup);
  await camera.harness.openGallery();
  camera.harness.uploadToGallery(files('a.jpg', 'b.jpg', 'c.jpg'));
  await waitFor(() => camera.harness.uploading === 3);
  camera.harness.closeGallery(); assert.equal(camera.harness.galleryOpen, false);
  await waitFor(() => camera.previewSource() === camera.video);
  camera.tap(); await waitFor(() => camera.harness.mode === 'working');
  camera.shake?.(); resolve();
  await waitFor(() => camera.harness.mode === 'done' && camera.harness.uploading === 0 && camera.estimates() === 4);
  await camera.harness.openGallery(); await waitFor(() => camera.harness.galleryItems.length === 4);
});

test('a reload resumes uploads that were still waiting', async t => {
  const database = memoryIndexedDB();
  const { createGallery: open } = await import('../src/lib/gallery.mjs');
  await open(database).enqueue([new File(['x'], 'left.jpg'), new File(['x'], 'behind.jpg')]);
  const camera = fixture(false, { database }); t.after(camera.cleanup);
  await waitFor(() => camera.estimates() === 2 && camera.harness.uploading === 0);
  await camera.harness.openGallery(); await waitFor(() => camera.harness.galleryItems.length === 2);
});

async function galleryWithImage(options) {
  const camera = fixture(false, options);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done' && camera.harness.currentId);
  await camera.harness.openGallery();
  return camera;
}
const tile = (camera, index = 0) => camera.harness.galleryItems[index];
const tileBox = { getBoundingClientRect: () => ({ left: 4, top: 60, right: 94, bottom: 150, width: 90, height: 90 }) };
const longPress = async (camera, item = tile(camera)) => {
  camera.harness.tileDown({ isPrimary: true, pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 50, currentTarget: tileBox }, item);
  await waitFor(() => camera.harness.menu?.file);
};

test('holding a gallery tile prepares the full image and shares it without opening the tile', async t => {
  const camera = await galleryWithImage({ share: () => true }); t.after(camera.cleanup);
  const item = tile(camera);
  await longPress(camera, item);
  assert.equal(camera.harness.menu.id, item.id); assert.equal(camera.harness.menu.file.type, 'image/png');
  assert.equal(camera.harness.galleryOpen, true, 'The menu sits in the grid instead of opening a viewer');
  assert.ok(camera.harness.menu.x >= 84 && camera.harness.menu.y === 158, 'The menu is placed beside the held tile');
  camera.harness.tileClick(item.id); assert.equal(camera.harness.galleryOpen, true, 'The click after a hold does not open the tile');
  camera.harness.shareMenu();
  assert.equal(camera.shared.length, 1); assert.equal(camera.shared[0].files[0].name, `entropi-djupn-${item.id}.png`);
  assert.equal(camera.harness.menu, null);
  await longPress(camera, item); camera.harness.saveMenu();
  assert.equal(camera.shared.length, 2, 'Saving to Photos on iOS goes through the share sheet'); assert.equal(camera.downloads.length, 0);
  camera.harness.tileDown({ isPrimary: true, pointerType: 'touch', pointerId: 8, clientX: 50, clientY: 50, currentTarget: tileBox }, item);
  camera.harness.cancelPress(); camera.harness.tileClick(item.id);
  await waitFor(() => !camera.harness.galleryOpen);
});

test('without file sharing, saving downloads the PNG', async t => {
  const camera = await galleryWithImage(); t.after(camera.cleanup);
  await longPress(camera);
  camera.harness.shareMenu(); assert.ok(camera.harness.menu, 'Share is unavailable and does nothing');
  camera.harness.saveMenu();
  assert.equal(camera.downloads.length, 1); assert.match(camera.downloads[0].download, /^entropi-djupn-.*\.png$/);
});

test('deleting a tile needs a second tap and removes it from the grid and storage', async t => {
  const database = memoryIndexedDB();
  const camera = await galleryWithImage({ database }); t.after(camera.cleanup);
  await longPress(camera);
  await camera.harness.deleteMenu();
  assert.equal(camera.harness.menu.armed, true); assert.equal(camera.harness.galleryItems.length, 1);
  await camera.harness.deleteMenu();
  assert.equal(camera.harness.menu, null); assert.equal(camera.harness.galleryItems.length, 0);
  assert.match(camera.harness.announcement, /sletta/);
  const next = fixture(false, { database }); t.after(next.cleanup);
  await next.harness.openGallery(); assert.equal(next.harness.galleryItems.length, 0);
});

test('scrolling the grid cancels a hold, and a short tap still opens the image', async t => {
  const camera = await galleryWithImage(); t.after(camera.cleanup);
  const item = tile(camera);
  camera.harness.tileDown({ isPrimary: true, pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 50, currentTarget: tileBox }, item);
  camera.harness.tileMove({ pointerId: 7, clientX: 50, clientY: 80 });
  await new Promise(done => setTimeout(done, 600));
  assert.equal(camera.harness.menu, null);
  camera.harness.cancelPress(); camera.harness.tileClick(item.id); await waitFor(() => camera.harness.mode === 'done' && !camera.harness.galleryOpen);
});

async function developed(options) {
  const camera = fixture(false, options);
  camera.tap(); await waitFor(() => camera.harness.mode === 'done');
  return camera;
}
// Real touch moves both fingers a few pixels per frame; replay a path the same way.
const gesture = (camera, frames) => {
  const { harness, point } = camera, [first] = frames, last = frames.at(-1);
  harness.artDown(point(1, ...first[0])); harness.artDown(point(2, ...first[1]));
  for (const [a, b] of frames.slice(1)) { harness.artMove(point(1, ...a)); harness.artMove(point(2, ...b)); }
  harness.artUp(point(2, ...last[1])); harness.artUp(point(1, ...last[0]));
};
const slide = (from, to, steps = 12) => Array.from({ length: steps + 1 }, (_, i) => from.map((finger, f) => finger.map((value, axis) => value + (to[f][axis] - value) * i / steps)));
const twist = (angle, steps = 12) => Array.from({ length: steps + 1 }, (_, i) => {
  const a = angle * i / steps;
  return [[200 - 50 * Math.cos(a), 300 - 50 * Math.sin(a)], [200 + 50 * Math.cos(a), 300 + 50 * Math.sin(a)]];
});
const twoFinger = (camera, from, to) => gesture(camera, slide(from, to));

test('two fingers dragged sideways set contrast and dragged up or down set the midtones', async t => {
  const camera = await developed(); t.after(camera.cleanup);
  twoFinger(camera, [[100, 300], [200, 300]], [[160, 300], [260, 300]]);
  assert.ok(camera.harness.contrast > 1.5); assert.equal(camera.harness.gamma, 1); assert.equal(camera.harness.bandWidth, 1);
  twoFinger(camera, [[100, 300], [200, 300]], [[100, 220], [200, 220]]);
  assert.ok(camera.harness.gamma < 1, 'Dragging up lightens the midtones'); assert.ok(camera.harness.contrast > 1.5);
  await waitFor(() => camera.paints.length > 1);
  assert.equal(camera.estimates(), 1); assert.equal(camera.writes.length, 0);
});

test('turning two fingers dials through the five expressions, and a two-finger double tap resets the tone', async t => {
  const camera = await developed(); t.after(camera.cleanup);
  assert.equal(camera.harness.preset, 1);
  gesture(camera, twist(1.1));
  assert.equal(camera.harness.preset, 3, 'About 63 degrees turns two steps');
  gesture(camera, twist(-.6));
  assert.equal(camera.harness.preset, 2);
  twoFinger(camera, [[100, 300], [200, 300]], [[160, 300], [260, 300]]);
  assert.ok(camera.harness.contrast > 1);
  for (let tap = 0; tap < 2; tap++) { camera.advancePointer(100); twoFinger(camera, [[100, 300], [200, 300]], [[100, 300], [200, 300]]); }
  assert.equal(camera.harness.contrast, 1); assert.equal(camera.harness.position, 0); assert.equal(camera.harness.preset, 2);
});

test('contrast and midtones are kept with the image in the gallery', async t => {
  const camera = await developed(); t.after(camera.cleanup);
  await waitFor(() => camera.harness.currentId);
  twoFinger(camera, [[100, 300], [200, 300]], [[160, 300], [260, 300]]);
  const kept = camera.harness.contrast;
  await new Promise(done => setTimeout(done, 700));
  await camera.harness.retake(); await camera.harness.openGallery();
  await camera.harness.openItem(camera.harness.galleryItems[0].id);
  assert.equal(camera.harness.contrast, kept);
});
