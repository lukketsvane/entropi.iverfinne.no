import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** @typedef {ReturnType<typeof import('../../../static/pointcloud/math.mjs').imageToPointCloud>} PointCloud */

/**
 * Lightweight immersive point-cloud renderer. Three visual treatments share the
 * same measured image colours and estimated depth. No synthetic 3D geometry.
 */
export class PointCloudViewer {
  /** @param {HTMLElement} host @param {PointCloud} cloud @param {(error: Error) => void} onError */
  constructor(host, cloud, onError = () => {}) {
    this.host = host;
    this.cloud = cloud;
    this.disposed = false;
    this.dirty = true;
    this.style = 'color';
    this.pointSize = 1;
    this.renderer = new THREE.WebGLRenderer({
      alpha: false, antialias: false, powerPreference: 'high-performance'
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.replaceChildren(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.7;
    this.controls.enablePan = true;
    this.controls.minDistance = cloud.radius * 0.28;
    this.controls.maxDistance = cloud.radius * 12;
    this.controls.touches.ONE = THREE.TOUCH.ROTATE;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.26;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
    const colors = new Float32Array(cloud.colors.length);
    const color = new THREE.Color();
    for (let i = 0; i < cloud.count; i++) {
      color.setRGB(cloud.colors[i * 3] / 255, cloud.colors[i * 3 + 1] / 255,
        cloud.colors[i * 3 + 2] / 255, THREE.SRGBColorSpace);
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uHeight: { value: 900 },
        uSize: { value: cloud.radius * 0.012 },
        uMode: { value: 0 },
        uRadius: { value: Math.max(0.01, cloud.radius) }
      },
      vertexShader: [
        'attribute vec3 color;',
        'uniform float uHeight;',
        'uniform float uSize;',
        'uniform float uRadius;',
        'varying vec3 vColor;',
        'varying float vDepth;',
        'void main() {',
        '  vec4 view = modelViewMatrix * vec4(position, 1.0);',
        '  gl_Position = projectionMatrix * view;',
        '  gl_PointSize = clamp(uSize * uHeight / max(0.01, -view.z), 1.35, 7.0);',
        '  vColor = color;',
        '  vDepth = clamp(0.5 + position.z / (2.0 * uRadius), 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision mediump float;',
        'uniform float uMode;',
        'varying vec3 vColor;',
        'varying float vDepth;',
        'void main() {',
        '  float d = length(gl_PointCoord - vec2(0.5));',
        '  float a = 1.0 - smoothstep(0.35, 0.5, d);',
        '  if (a < 0.015) discard;',
        '  vec3 silver = vec3(0.77, 0.84, 0.88) * (0.65 + vDepth * 0.45);',
        '  vec3 nearTone = vec3(0.86, 0.93, 0.96);',
        '  vec3 farTone = vec3(0.18, 0.41, 0.51);',
        '  vec3 depthColor = mix(farTone, nearTone, vDepth);',
        '  vec3 rgb = uMode < 0.5 ? vColor : (uMode < 1.5 ? silver : depthColor);',
        '  if (uMode > 2.5) rgb = vec3(0.32 + 0.68 * dot(vColor, vec3(0.299, 0.587, 0.114)));',
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
      if (this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
    };
    this.animation = requestAnimationFrame(frame);
  }

  /** @param {'color' | 'silver' | 'depth' | 'mono'} style */
  setStyle(style) {
    if (!['color', 'silver', 'depth', 'mono'].includes(style)) return;
    this.style = style;
    this.points.material.uniforms.uMode.value = { color: 0, silver: 1, depth: 2, mono: 3 }[style];
    this.dirty = true;
  }

  /** @param {number} multiplier */
  setPointSize(multiplier) {
    if (!Number.isFinite(multiplier)) return;
    this.pointSize = Math.max(0.5, Math.min(2.2, multiplier));
    this.points.material.uniforms.uSize.value = this.cloud.radius * 0.012 * this.pointSize;
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

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animation);
    this.observer?.disconnect();
    window.removeEventListener('resize', this.resize);
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
