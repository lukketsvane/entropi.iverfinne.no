import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {HeadParallax} from './head-parallax.mjs';
import {attachViewerGestures, noAdjust} from './viewer-gestures.ts';

/** @typedef {{position:number[],target:number[],up:number[],fov:number,aspect?:number}} SceneCamera */

/** Render covariance, orientation, opacity and colour, rather than converting Gaussians to dots.
 * @param {HTMLElement} host @param {Uint8Array} bytes @param {SceneCamera} initial
 * @param {(error:Error)=>void} onError @param {AbortSignal} signal */
export async function createGaussianViewer(host, bytes, initial, onError, signal, onAdjust = noAdjust) {
  const {SparkRenderer, SplatMesh} = await import('@sparkjsdev/spark');
  signal.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({antialias: false, alpha: false, powerPreference: 'high-performance'});
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, .01, 1000);
  const spark = new SparkRenderer({renderer, maxStdDev: Math.sqrt(8), minAlpha: 1 / 255});
  scene.add(spark);
  const mesh = new SplatMesh({fileBytes: bytes, fileName: 'scene.splat', lod: true, enableLod: false});
  // Both model pipelines export OpenCV coordinates (x right, y down, z forward).
  mesh.rotation.x = Math.PI;
  scene.add(mesh);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = .08;
  controls.rotateSpeed = .4; controls.zoomSpeed = .65;
  const gestures = attachViewerGestures(renderer.domElement, {
    onDensity(value) {
      mesh.enableLod = value < 0.999;
      spark.lodSplatCount = Math.max(1, Math.round(mesh.numSplats * value));
      spark.setDirty();
    },
    onPinch(scale) {
      const offset = camera.position.clone().sub(controls.target);
      offset.multiplyScalar(THREE.MathUtils.clamp(offset.length() / scale, controls.minDistance, controls.maxDistance) / offset.length());
      camera.position.copy(controls.target).add(offset);
      controls.update();
    },
    onAdjust
  });
  const parallax = new HeadParallax();
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let disposed = false, animation = 0;
  // Parsing may finish after a shake. Release buffers produced by that late completion too.
  void mesh.initialized.then(() => { if (disposed) mesh.dispose(); }).catch(() => {});
  /** @type {ResizeObserver|undefined} */ let observer;
  const lost = (/** @type {Event} */ event) => { event.preventDefault(); if (!disposed) onError(new Error('Gaussian-visinga stoppa.')); };
  function dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(animation); observer?.disconnect();
    signal.removeEventListener('abort', dispose);
    renderer.domElement.removeEventListener('webglcontextlost', lost);
    gestures.dispose(); controls.dispose(); mesh.dispose(); spark.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  }
  signal.addEventListener('abort', dispose, {once: true});
  renderer.domElement.addEventListener('webglcontextlost', lost);
  try {
    await mesh.initialized;
    signal.throwIfAborted();
    const flip = (/** @type {number[]} */ v) => new THREE.Vector3(v[0], -v[1], -v[2]);
    if (!initial || !Number.isFinite(initial.fov) || ![initial.position, initial.target, initial.up].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) {
      throw new Error('Kameraposisjonen for Gaussian-scena manglar.');
    }
    camera.position.copy(flip(initial.position)); camera.up.copy(flip(initial.up)).normalize();
    controls.target.copy(flip(initial.target));
    const sourceFov = THREE.MathUtils.clamp(initial.fov, 25, 110);
    const distance = Math.max(.01, camera.position.distanceTo(controls.target));
    camera.near = distance / 1000; camera.far = distance * 1000;
    controls.minDistance = distance * .15; controls.maxDistance = distance * 5;
    controls.update();
    host.replaceChildren(renderer.domElement);
    const resize = () => {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false); camera.aspect = width / height;
      camera.fov = Math.min(120, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(sourceFov / 2)) * Math.max(1, (initial.aspect || camera.aspect) / camera.aspect))));
      camera.updateProjectionMatrix();
    };
    observer = new ResizeObserver(resize); observer.observe(host); resize();
    await spark.update({scene, camera}); renderer.render(scene, camera);
    signal.throwIfAborted();
    let last = 0;
    const frame = (/** @type {number} */ time) => {
      if (disposed) return;
      animation = requestAnimationFrame(frame);
      if (document.hidden || time - last < 33) return;
      last = time; controls.update();
      renderer.render(scene, parallax.camera(camera, controls.target, time, reduced));
    };
    animation = requestAnimationFrame(frame);
    return {
      setHeadPose(/** @type {import('./head-parallax.mjs').HeadPose|null} */ pose) { parallax.setPose(pose); },
      snapshot() {
        if (disposed) throw new Error('Gaussian-scena er tømd.');
        const canvas = document.createElement('canvas'); canvas.width = 384;
        canvas.height = Math.max(1, Math.min(1024, Math.round(384 * host.clientHeight / Math.max(1, host.clientWidth))));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Kunne ikkje klargjere Gaussian-utskrifta.');
        // Re-render synchronously so iOS has not discarded the drawing buffer.
        renderer.render(scene, camera);
        context.filter = gestures.state.filter;
        context.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
        return canvas;
      },
      dispose
    };
  } catch (error) { dispose(); throw error; }
}
