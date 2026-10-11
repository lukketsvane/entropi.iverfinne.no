import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** @typedef {ReturnType<typeof import('../../../static/pointcloud/math.mjs').imageToPointCloud>} PointCloud */

export class PointCloudViewer {
  /** @param {HTMLElement} host @param {PointCloud} cloud @param {(error: Error) => void} onError */
  constructor(host, cloud, onError = () => {}) {
    this.host = host; this.cloud = cloud; this.disposed = false;
    this.renderer = new THREE.WebGLRenderer({ alpha: false, antialias: false, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x030303, 1);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.replaceChildren(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, .01, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .1;
    this.controls.rotateSpeed = .6;
    this.controls.zoomSpeed = .7;
    this.controls.minDistance = cloud.radius * .25;
    this.controls.maxDistance = cloud.radius * 12;
    this.controls.touches.ONE = THREE.TOUCH.ROTATE;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
    const colors = new Float32Array(cloud.colors.length), color = new THREE.Color();
    for (let i = 0; i < cloud.count; i++) {
      color.setRGB(cloud.colors[i * 3] / 255, cloud.colors[i * 3 + 1] / 255, cloud.colors[i * 3 + 2] / 255, THREE.SRGBColorSpace);
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.PointsMaterial({ size: cloud.radius * .004, vertexColors: true, sizeAttenuation: true, toneMapped: false });
    this.points = new THREE.Points(geometry, material);
    this.scene.add(this.points);
    /** @param {Event} event */
    this.onLost = event => { event.preventDefault(); if (!this.disposed) onError(new Error('3D-visinga stoppa. Opne punktskyen på nytt.')); };
    this.renderer.domElement.addEventListener('webglcontextlost', this.onLost);
    this.resize = () => {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false); this.dirty = true;
    };
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(this.resize) : null;
    this.observer?.observe(host);
    window.addEventListener('resize', this.resize);
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.resize(); this.reset();
    let previous = 0;
    this.animation = 0;
    /** @param {number} time */
    const frame = time => {
      if (this.disposed) return;
      this.animation = requestAnimationFrame(frame);
      if (document.hidden || time - previous < 30) return;
      previous = time; this.controls.update();
      if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    };
    this.animation = requestAnimationFrame(frame);
  }
  reset() {
    const vertical = this.camera.fov * Math.PI / 360;
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const distance = this.cloud.radius / Math.sin(Math.min(vertical, horizontal)) * 1.08;
    this.camera.position.set(.07, .025, 1).normalize().multiplyScalar(distance);
    this.controls.target.set(0, 0, 0); this.controls.update(); this.dirty = true;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; cancelAnimationFrame(this.animation);
    this.observer?.disconnect(); window.removeEventListener('resize', this.resize);
    this.controls.dispose(); this.points.geometry.dispose(); this.points.material.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onLost);
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}
