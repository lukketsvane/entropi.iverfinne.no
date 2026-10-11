import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {CanvasPointCloudViewer} from './canvas-viewer.mjs';
import {HeadParallax} from './head-parallax.mjs';
import {attachViewerGestures, noAdjust, progressiveIndices} from './viewer-gestures.ts';
import {rotateTouchCamera, transformTouchCamera} from './touch-camera.ts';
import {nearestC64} from './c64-palette.ts';

/** @typedef {ReturnType<typeof import('../../../static/pointcloud/math.mjs').imageToPointCloud>} PointCloud */

/** @param {HTMLElement} host @param {PointCloud} cloud @param {(error:Error)=>void} onError */
export function createPointCloudViewer(host,cloud,onError,onAdjust = noAdjust) {
  try {return new PointCloudViewer(host,cloud,onError,onAdjust);}
  catch {return new CanvasPointCloudViewer(host,cloud,onAdjust);}
}

/**
 * Lightweight immersive point-cloud renderer. Three visual treatments share the
 * same measured image colours and estimated depth. No synthetic 3D geometry.
 */
export class PointCloudViewer {
  /** @param {HTMLElement} host @param {PointCloud} cloud @param {(error: Error) => void} onError */
  constructor(host, cloud, onError = () => {}, onAdjust = noAdjust) {
    this.host = host;
    this.cloud = cloud;
    this.disposed = false;
    this.dirty = true;
    this.style = 'color';
    this.pointSize = 1;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true, antialias: false, powerPreference: 'high-performance'
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.replaceChildren(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100);
    this.parallax = new HeadParallax();
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.7;
    this.controls.enablePan = true;
    this.controls.minDistance = cloud.radius * 0.28;
    this.controls.maxDistance = cloud.radius * 1000;
    this.camera.far = Math.max(100, this.controls.maxDistance + cloud.radius * 2);
    this.camera.updateProjectionMatrix();
    this.controls.zoomToCursor = true;
    this.controls.touches.ONE = null;
    this.controls.touches.TWO = null;
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.26;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
    geometry.setIndex(progressiveIndices(cloud.count));
    const colors = new Float32Array(cloud.colors.length);
    const color = new THREE.Color();
    for (let i = 0; i < cloud.count; i++) {
      const [red, green, blue] = nearestC64(cloud.colors[i * 3], cloud.colors[i * 3 + 1], cloud.colors[i * 3 + 2]);
      color.setRGB(red / 255, green / 255, blue / 255, THREE.SRGBColorSpace);
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uHeight: { value: 900 },
        uSize: { value: cloud.radius * 0.0095 },
        uDefinition: { value: 0.5 },
        uMode: { value: 0 },
        uRadius: { value: Math.max(0.01, cloud.radius) }
      },
      vertexShader: [
        'attribute vec3 color;',
        'uniform float uHeight;',
        'uniform float uSize;',
        'uniform float uRadius;',
        'varying vec3 vColor;',
        'varying vec3 vPosition;',
        'varying float vDepth;',
        'void main() {',
        '  vec4 view = modelViewMatrix * vec4(position, 1.0);',
        '  gl_Position = projectionMatrix * view;',
        '  gl_PointSize = clamp(uSize * uHeight / max(0.01, -view.z), 0.25, 24.0);',
        '  vColor = color;',
        '  vPosition = position;',
        '  vDepth = clamp(0.5 + position.z / (2.0 * uRadius), 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision mediump float;',
        'uniform float uMode;',
        'uniform float uDefinition;',
        'varying vec3 vColor;',
        'varying vec3 vPosition;',
        'varying float vDepth;',
        'void main() {',
        '  float d = length(gl_PointCoord - vec2(0.5));',
        '  float a = 1.0 - smoothstep(mix(0.26, 0.46, uDefinition), mix(0.5, 0.47, uDefinition), d);',
        '  if (a < 0.015) discard;',
        '  vec3 silver = vec3(0.77, 0.84, 0.88) * (0.65 + vDepth * 0.45);',
        '  vec3 nearTone = vec3(0.86, 0.93, 0.96);',
        '  vec3 farTone = vec3(0.18, 0.41, 0.51);',
        '  vec3 depthColor = mix(farTone, nearTone, vDepth);',
        '  vec3 rgb = uMode < 0.5 ? vColor : (uMode < 1.5 ? silver : depthColor);',
        '  if (uMode > 2.5) rgb = vec3(0.32 + 0.68 * dot(vColor, vec3(0.299, 0.587, 0.114)));',
        '  if (uMode > 3.5) {',
        '    float seed = dot(vPosition, vec3(127.1, 311.7, 74.7));',
        '    float dither = fract(sin(seed) * 43758.5453);',
        '    float threshold = 0.22 + dither * 0.56;',
        '    vec3 phosphor = step(vec3(threshold), pow(clamp(vColor, 0.0, 1.0), vec3(0.67)));',
        '    rgb = phosphor * vec3(1.0, 0.94, 1.0);',
        '  }',
        '  gl_FragColor = vec4(rgb, a * 0.97);',
        '  #include <colorspace_fragment>',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: false
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.gestures = attachViewerGestures(this.renderer.domElement, {
      onDensity: value => { geometry.setDrawRange(0, Math.max(1, Math.round(cloud.count * value))); this.dirty = true; },
      onDefinition: value => {
        this.setPointSize(4 ** (1 - 2 * value));
        material.uniforms.uDefinition.value = value;
        this.dirty = true;
      },
      onRotate: (x, y) => {
        rotateTouchCamera(this.camera, this.controls, x, y, this.renderer.domElement.clientHeight);
        this.dirty = true;
      },
      onTransform: (x, y, scale, focusX, focusY) => {
        transformTouchCamera(this.camera, this.controls, x, y, scale, focusX, focusY, this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight);
        this.dirty = true;
      },
      onTouch: active => {
        this.touching = active;
        if (active) { this.parallax.position.set(0, 0, 0); this.parallax.setPose(null); }
        else this.parallax.setPose(this.lastPose || null);
        this.dirty = true;
      },
      onAdjust
    });

    /** @param {Event} event */
    this.onLost = event => {
      event.preventDefault();
      if (!this.disposed) onError(new Error('3D-visinga stoppa. Prøv punktskyen på nytt.'));
    };
    this.onInteract = () => { this.controls.autoRotate = false; this.dirty = true; };
    this.renderer.domElement.addEventListener('webglcontextlost', this.onLost);
    this.renderer.domElement.addEventListener('pointerdown', this.onInteract, { passive: true });
    this.renderer.domElement.addEventListener('wheel', this.onInteract, { passive: true });
    this.resize = () => {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      material.uniforms.uHeight.value = height * this.renderer.getPixelRatio();
      this.dirty = true;
    };
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(this.resize) : null;
    this.observer?.observe(host);
    window.addEventListener('resize', this.resize);
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.resize();
    this.reset();

    let previous = 0;
    this.animation = 0;
    /** @param {number} time */
    const frame = time => {
      if (this.disposed) return;
      this.animation = requestAnimationFrame(frame);
      if (document.hidden || time - previous < 32) return;
      previous = time;
      this.controls.update();
      if (this.dirty || this.parallax.moving) {
        this.renderer.render(this.scene, this.parallax.camera(this.camera,this.controls.target,time,this.reducedMotion));
        this.dirty = false;
      }
    };
    this.animation = requestAnimationFrame(frame);
  }

  /** @param {import('./head-parallax.mjs').HeadPose|null} pose */
  setHeadPose(pose) {
    this.lastPose = pose;
    if (!this.touching) this.parallax.setPose(pose);
    if(pose)this.controls.autoRotate=false;
    this.dirty=true;
  }

  /** @param {'color' | 'silver' | 'depth' | 'mono' | 'crt'} style */
  setStyle(style) {
    if (!['color', 'silver', 'depth', 'mono', 'crt'].includes(style)) return;
    this.style = style;
    this.points.material.uniforms.uMode.value = { color: 0, silver: 1, depth: 2, mono: 3, crt: 4 }[style];
    this.dirty = true;
  }

  /** @param {number} multiplier */
  setPointSize(multiplier) {
    if (!Number.isFinite(multiplier)) return;
    this.pointSize = Math.max(0.02, Math.min(8, multiplier));
    this.points.material.uniforms.uSize.value = this.cloud.radius * 0.0095 * this.pointSize;
    this.dirty = true;
  }

  reset() {
    const vertical = this.camera.fov * Math.PI / 360;
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const distance = this.cloud.radius / Math.sin(Math.min(vertical, horizontal)) * 1.08;
    this.camera.position.set(0.16, 0.045, 1).normalize().multiplyScalar(distance);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.dirty = true;
  }

  /** Monochrome copy for paper; capture synchronously before WebGL clears its buffer. */
  snapshot() {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = Math.max(1, Math.min(1024, Math.round(384 * this.host.clientHeight / Math.max(1, this.host.clientWidth))));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Kunne ikkje lese punktskyen.');
    const mode = this.points.material.uniforms.uMode.value;
    try {
      this.points.material.uniforms.uMode.value = 3;
      this.renderer.render(this.scene, this.camera);
      context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.filter = this.gestures.state.filter;
      context.drawImage(this.renderer.domElement, 0, 0, canvas.width, canvas.height);
    } finally {
      this.points.material.uniforms.uMode.value = mode;
      this.renderer.render(this.scene, this.camera);
      this.dirty = true;
    }
    return canvas;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animation);
    this.observer?.disconnect();
    window.removeEventListener('resize', this.resize);
    this.gestures.dispose();
    this.controls.dispose();
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onLost);
    this.renderer.domElement.removeEventListener('pointerdown', this.onInteract);
    this.renderer.domElement.removeEventListener('wheel', this.onInteract);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
