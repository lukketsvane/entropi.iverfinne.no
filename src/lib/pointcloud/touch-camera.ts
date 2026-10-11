import {MathUtils, Quaternion, Spherical, Vector3, type PerspectiveCamera} from 'three';

const upward = new Vector3(0, 1, 0);
type TouchControls = {target: Vector3; rotateSpeed: number; minDistance: number; maxDistance: number; update(): void};

export function rotateTouchCamera(camera: PerspectiveCamera, controls: TouchControls, dx: number, dy: number, height: number) {
  const align = new Quaternion().setFromUnitVectors(camera.up.clone().normalize(), upward);
  const offset = camera.position.clone().sub(controls.target).applyQuaternion(align);
  const spherical = new Spherical().setFromVector3(offset);
  spherical.theta -= 2 * Math.PI * dx * controls.rotateSpeed / Math.max(1, height);
  spherical.phi -= 2 * Math.PI * dy * controls.rotateSpeed / Math.max(1, height);
  spherical.makeSafe();
  camera.position.copy(controls.target).add(offset.setFromSpherical(spherical).applyQuaternion(align.invert()));
  controls.update();
}

export function transformTouchCamera(camera: PerspectiveCamera, controls: TouchControls, dx: number, dy: number, scale: number, focusX: number, focusY: number, width: number, height: number) {
  if (!Number.isFinite(scale) || scale <= 0) return;
  const distance = camera.position.distanceTo(controls.target);
  const nextDistance = MathUtils.clamp(distance / scale, controls.minDistance, controls.maxDistance);
  const pixelsToWorld = 2 * Math.tan(MathUtils.degToRad(camera.fov / 2)) / Math.max(1, height);
  const before = distance * pixelsToWorld;
  const after = nextDistance * pixelsToWorld;
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const shift = right.multiplyScalar(-dx * before + (focusX - width / 2) * (before - after));
  shift.addScaledVector(up, dy * before - (focusY - height / 2) * (before - after));
  camera.position.sub(controls.target).multiplyScalar(nextDistance / distance).add(controls.target).add(shift);
  controls.target.add(shift);
  controls.update();
}
