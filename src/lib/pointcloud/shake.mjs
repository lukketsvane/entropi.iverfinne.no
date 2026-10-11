/** @typedef {{x:number|null,y:number|null,z:number|null}} Acceleration */
/** @typedef {{acceleration?:Acceleration|null,accelerationIncludingGravity?:Acceleration|null}} MotionSample */
/** @typedef {Window & {DeviceMotionEvent?:typeof DeviceMotionEvent & {requestPermission?:()=>Promise<'granted'|'denied'>}}} MotionWindow */

/** Three strong, alternating accelerations distinguish a shake from panning or a bump. */
export class ShakeDetector {
  constructor() {
    this.threshold = 13; // m/s², excluding gravity
    this.cooldownUntil = 0;
    /** @type {{sign:number,peaks:number,first:number,last:number}[]} */ this.axes = [];
    /** @type {number[]|null} */ this.gravity = null;
    /** @type {number|null} */ this.lastSample = null;
    this.reset();
  }
  reset() {
    this.axes = Array.from({ length: 3 }, () => ({ sign: 0, peaks: 0, first: 0, last: 0 }));
    this.gravity = null;
    this.lastSample = null;
  }
  /** @param {Acceleration|null|undefined} value @returns {number[]|null} */
  vector(value) {
    if (!value || ![value.x, value.y, value.z].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    return [/** @type {number} */ (value.x), /** @type {number} */ (value.y), /** @type {number} */ (value.z)];
  }
  /** @param {MotionSample} sample @param {number} now */
  sample(sample, now) {
    if (!Number.isFinite(now)) return false;
    if (this.lastSample !== null && (now <= this.lastSample || now - this.lastSample > 400)) this.reset();
    const elapsed = this.lastSample === null ? 16 : Math.min(100, now - this.lastSample);
    this.lastSample = now;
    let acceleration = this.vector(sample.acceleration);
    if (!acceleration) {
      const measured = this.vector(sample.accelerationIncludingGravity);
      if (!measured) { this.reset(); return false; }
      if (!this.gravity) { this.gravity = measured; return false; }
      // Remove gravity when a browser only supplies accelerationIncludingGravity.
      const alpha = 1 - Math.exp(-elapsed / 240);
      acceleration = measured.map((value, axis) => {
        const gravity = /** @type {number[]} */ (this.gravity);
        gravity[axis] += alpha * (value - gravity[axis]);
        return value - gravity[axis];
      });
    } else this.gravity = null;
    if (now < this.cooldownUntil) return false;
    for (let axis = 0; axis < 3; axis++) {
      const value = acceleration[axis], peak = this.axes[axis];
      if (Math.abs(value) < this.threshold) continue;
      const sign = Math.sign(value);
      if (!peak.peaks || now - peak.first > 800) {
        Object.assign(peak, { sign, peaks: 1, first: now, last: now });
      } else if (sign !== peak.sign && now - peak.last >= 60) {
        peak.sign = sign; peak.last = now; peak.peaks++;
        if (peak.peaks >= 3) {
          this.cooldownUntil = now + 1200;
          this.axes.forEach(state => { state.sign = 0; state.peaks = 0; });
          return true;
        }
      }
    }
    return false;
  }
}

/** iOS permission uses an existing shutter gesture; no extra control or visible copy. */
export class ShakeToClear {
  /** @param {{target:MotionWindow,hasDraft:()=>boolean,clear:()=>void,now?:()=>number}} options */
  constructor({ target, hasDraft, clear, now = () => performance.now() }) {
    this.target = target; this.hasDraft = hasDraft; this.clear = clear; this.now = now;
    this.detector = new ShakeDetector();
    this.active = false; this.disposed = false; this.granted = false;
    this.attempted = false; this.pending = false; this.listening = false;
    /** @param {DeviceMotionEvent} event */
    this.onMotion = event => {
      if (!this.active || this.disposed) return;
      if (!this.hasDraft()) { this.detector.reset(); return; }
      if (this.detector.sample(event, this.now())) this.clear();
    };
  }
  start() {
    if (this.disposed) return;
    this.active = true;
    const motion = this.target.DeviceMotionEvent;
    if (motion && typeof motion.requestPermission !== 'function') this.granted = true;
    if (this.granted && !this.listening) {
      this.target.addEventListener('devicemotion', this.onMotion);
      this.listening = true;
    }
  }
  /** Call synchronously from pointerdown/click. True reserves the permission gesture. */
  requestFromGesture() {
    if (this.disposed) return false;
    if (this.pending) return true;
    const motion = this.target.DeviceMotionEvent;
    if (this.granted || this.attempted || typeof motion?.requestPermission !== 'function') return false;
    this.attempted = true; this.pending = true;
    let request;
    try { request = motion.requestPermission(); }
    catch { this.pending = false; return true; }
    void Promise.resolve(request).then(permission => {
      if (this.disposed) return;
      this.granted = permission === 'granted';
      if (this.active) this.start();
    }).catch(() => {}).finally(() => { this.pending = false; });
    return true;
  }
  suspend() {
    this.active = false; this.detector.reset();
    this.target.removeEventListener('devicemotion', this.onMotion); this.listening = false;
  }
  dispose() { this.disposed = true; this.suspend(); }
}
