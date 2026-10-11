import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {HeadParallax} from './head-parallax.mjs';
import {attachViewerGestures, noAdjust} from './viewer-gestures.ts';
import {rotateTouchCamera, transformTouchCamera} from './touch-camera.ts';
import {nearestC64} from './c64-palette.ts';

/** @typedef {{position:number[],target:number[],up:number[],fov:number,aspect?:number,bounds?:{center:number[],radius:number}}} SceneCamera */

/** Render covariance, orientation, opacity and colour, rather than converting Gaussians to dots.
 * @param {HTMLElement} host @param {Uint8Array} bytes @param {SceneCamera} initial
 * @param {(error:Error)=>void} onError @param {AbortSignal} signal */
export async function createGaussianViewer(host, bytes, initial, onError, signal, onAdjust = noAdjust, detailLevel = 2) {
  const {SparkRenderer, SplatMesh, dyno} = await import('@sparkjsdev/spark');
  signal.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({antialias: false, alpha: true, powerPreference: 'high-performance'});
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, .01, 1000);
  const lodBudget = globalThis.matchMedia?.('(pointer:coarse)').matches ? 450_000 : 3_250_000;
  const initialDensity = detailLevel === 1 ? .38 : detailLevel === 3 ? 1 : .77;
  const spark = new SparkRenderer({renderer, maxStdDev: Math.sqrt(8), minAlpha: 1 / 255, lodSplatCount: Math.round(lodBudget * initialDensity)});
  scene.add(spark);
  const splatSize = dyno.dynoFloat(1);
  const splatOpacity = dyno.dynoFloat(1);
  const sizeModifier = dyno.dynoBlock({gsplat: dyno.Gsplat}, {gsplat: dyno.Gsplat}, ({gsplat}) => {
    if (!gsplat) throw new Error('Gaussian-data manglar.');
    const values = dyno.splitGsplat(gsplat).outputs;
    return {gsplat: dyno.combineGsplat({gsplat, scales: dyno.mul(values.scales, splatSize), opacity: dyno.mul(values.opacity, splatOpacity)})};
  });
  for (let offset = 24; offset + 3 < bytes.length; offset += 32) {
    if (!bytes[offset + 3]) continue;
    const [red, green, blue] = nearestC64(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
    bytes[offset] = red; bytes[offset + 1] = green; bytes[offset + 2] = blue;
  }
  const mesh = new SplatMesh({fileBytes: bytes, fileName: 'scene.splat', lod: true, enableLod: true, worldModifier: sizeModifier});
  // Both model pipelines export OpenCV coordinates (x right, y down, z forward).
  mesh.rotation.x = Math.PI;
  scene.add(mesh);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = .12;
  controls.rotateSpeed = .4; controls.zoomSpeed = .65;
  controls.zoomToCursor = true;
  controls.touches.ONE = null; controls.touches.TWO = null;
  const parallax = new HeadParallax();
  let touching = false, lastPose = {x: 0, y: 0, z: 0};
  const gestures = attachViewerGestures(renderer.domElement, {
    initialDensity,
    onDensity(value) {
      spark.lodSplatCount = Math.max(1, Math.round(lodBudget * value));
      spark.setDirty();
    },
    onDefinition(value) {
      const scale = 4 ** (1 - 2 * value), opacity = 4 ** (value - .5);
      splatSize.value = scale;
      splatSize.uniform.value = scale;
      splatOpacity.value = opacity;
      splatOpacity.uniform.value = opacity;
      mesh.needsUpdate = true;
      spark.setDirty();
    },
    onRotate(x, y) {
      rotateTouchCamera(camera, controls, x, y, renderer.domElement.clientHeight);
    },
    onTransform(x, y, scale, focusX, focusY) {
      transformTouchCamera(camera, controls, x, y, scale, focusX, focusY, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
    },
    onTouch(active) {
      touching = active;
      if (active) { parallax.position.set(0, 0, 0); parallax.setPose(null); }
      else parallax.setPose(lastPose);
    },
    onAdjust
  });
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
    const sceneCenter = initial.bounds?.center;
    const sceneBoundsRadius = initial.bounds?.radius;
    const bounds = Array.isArray(sceneCenter) && sceneCenter.length === 3 && sceneCenter.every(Number.isFinite) &&
      typeof sceneBoundsRadius === 'number' && Number.isFinite(sceneBoundsRadius) && sceneBoundsRadius >= 0
      ? {center: flip(sceneCenter), radius: sceneBoundsRadius} : null;
    camera.near = distance / 1000;
    controls.minDistance = distance * .05;
    controls.update();
    host.replaceChildren(renderer.domElement);
    const updateZoomLimit = () => {
      const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2);
      const halfAngle = Math.min(halfVertical, Math.atan(Math.tan(halfVertical) * camera.aspect));
      const offset = bounds?.center.clone().sub(controls.target);
      const direction = camera.position.clone().sub(controls.target).normalize();
      const along = offset?.dot(direction) ?? 0;
      const across = offset ? Math.sqrt(Math.max(0, offset.lengthSq() - along * along)) : 0;
      const fitDistance = bounds ? along + bounds.radius / Math.sin(halfAngle) + across / Math.tan(halfAngle) : 0;
      controls.maxDistance = Math.max(distance * 1000, fitDistance * 1.25);
      camera.far = Math.max(distance * 1000, controls.maxDistance + (offset?.length() ?? 0) + (bounds?.radius ?? 0));
      camera.updateProjectionMatrix();
    };
    const resize = () => {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false); camera.aspect = width / height;
      camera.fov = Math.max(sourceFov, Math.min(64, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(sourceFov / 2)) * Math.max(1, (initial.aspect || camera.aspect) / camera.aspect)))));
      updateZoomLimit();
    };
    controls.addEventListener('change', updateZoomLimit);
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
      setHeadPose(/** @type {import('./head-parallax.mjs').HeadPose|null} */ pose) { lastPose = pose || {x: 0, y: 0, z: 0}; if (!touching) parallax.setPose(pose); },
      snapshot() {
        if (disposed) throw new Error('Gaussian-scena er tømd.');
        const canvas = document.createElement('canvas'); canvas.width = 384;
        canvas.height = Math.max(1, Math.min(1024, Math.round(384 * host.clientHeight / Math.max(1, host.clientWidth))));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Kunne ikkje klargjere Gaussian-utskrifta.');
        // Re-render synchronously so iOS has not discarded the drawing buffer.
        renderer.render(scene, camera);
        context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.filter = gestures.state.filter;
        context.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
        return canvas;
      },
      dispose
    };
  } catch (error) { dispose(); throw error; }
}
