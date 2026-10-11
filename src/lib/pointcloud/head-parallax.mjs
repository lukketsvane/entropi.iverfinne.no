import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

/** @typedef {{x:number,y:number,z:number}} HeadPose */

/** A moving eye behind a fixed screen, separate from touch orbit and zoom. */
export class HeadParallax {
  constructor() {
    this.view = new PerspectiveCamera();
    this.target = new Vector3(); this.position = new Vector3();
    this.right = new Vector3(); this.up = new Vector3(); this.back = new Vector3();
    this.last = 0;
    this.offset = {x:0,y:0,z:0,screen:1,scale:1};
  }
  /** @param {HeadPose|null} pose */
  setPose(pose) {
    /** @param {number} value */
    const finite = value => Number.isFinite(value) ? MathUtils.clamp(value,-1,1) : 0;
    this.target.set(finite(pose?.x ?? 0),finite(pose?.y ?? 0),finite(pose?.z ?? 0));
  }
  get moving() { return this.position.distanceToSquared(this.target) > .000001; }
  /** @param {number} distance @param {number} aspect @param {number} now @param {boolean} [reduced] */
  offsets(distance,aspect,now,reduced=false) {
    const dt=this.last ? Math.min(Math.max((now-this.last)/1000,0),.05) : 1/60;
    this.last=now;this.position.lerp(this.target,1-Math.exp(-dt/.09));
    if(!this.moving)this.position.copy(this.target);
    const gain=reduced ? .35 : 1,out=this.offset;
    out.x=this.position.x*distance*.12*Math.min(1,aspect)*gain;
    out.y=this.position.y*distance*.09*Math.min(1,1/aspect)*gain;
    out.z=this.position.z*distance*.12*gain;
    out.screen=distance*.8;out.scale=(out.screen+out.z)/out.screen;
    return out;
  }
  /** @param {PerspectiveCamera} base @param {Vector3} focus @param {number} now @param {boolean} [reduced] */
  camera(base,focus,now,reduced=false) {
    const {x,y,z,screen,scale}=this.offsets(Math.max(base.position.distanceTo(focus),base.near*4),base.aspect,now,reduced);
    this.view.copy(base);
    this.right.set(1,0,0).applyQuaternion(base.quaternion);
    this.up.set(0,1,0).applyQuaternion(base.quaternion);
    this.back.set(0,0,1).applyQuaternion(base.quaternion);
    this.view.position.addScaledVector(this.right,x).addScaledVector(this.up,y).addScaledVector(this.back,z);
    const projection=this.view.projectionMatrix.elements,horizontal=projection[0],vertical=projection[5];
    projection[0]*=scale;projection[5]*=scale;
    projection[8]-=x*horizontal/screen;projection[9]-=y*vertical/screen;
    this.view.projectionMatrixInverse.copy(this.view.projectionMatrix).invert();
    this.view.updateMatrixWorld(true);
    return this.view;
  }
}
