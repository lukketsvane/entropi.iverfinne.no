import type { HeadPose } from "./head-parallax.mjs";

export type TrackingState = "starting" | "calibrating" | "tracking" | "searching";
type Face = { x: number; y: number; size: number };
type Events = { pose: (pose: HeadPose | null) => void; state: (state: TrackingState) => void; error: (message: string) => void };

/** No recording, uploads, or persistence: frames are transferred to a local worker. */
export class HeadTracker {
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private stopped = false;
  private frame = 0;
  private busy = false;
  private sentAt = 0;
  private lastSent = 0;
  private lastVideoTime = -1;
  private lastSeen = 0;
  private interval = 80;
  private baseline: Face | null = null;
  private samples: Face[] = [];
  private state: TrackingState = "starting";
  private cancelInitialization: (() => void) | null = null;

  constructor(private video: HTMLVideoElement, private events: Events) {}

  async start() {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.Worker || !window.createImageBitmap) {
        throw new Error("unsupported");
      }
      this.changeState("starting");
      // The browser handles camera permission. Audio is explicitly disabled.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20, max: 24 } },
      });
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getVideoTracks().forEach(track => track.addEventListener("ended", this.onEnded));
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      await this.video.play();
      if (this.stopped) return;
      await this.initializeWorker();
      if (this.stopped) return;
      this.video.addEventListener("resize", this.recenter);
      window.addEventListener("orientationchange", this.recenter);
      this.recenter();
      this.lastSeen = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    } catch (error) {
      if (this.stopped) return;
      this.stop();
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
      this.events.error(name === "NotAllowedError" || name === "SecurityError"
        ? "Kameratilgang vart avslått. Du kan framleis dra for å rotere."
        : name === "NotFoundError" || name === "NotReadableError"
          ? "Frontkameraet er ikkje tilgjengeleg. Prøv igjen når kameraet er ledig."
          : message === "unsupported"
            ? "Opne studioet i Safari på iPhone for å bruke frontkameraet."
            : "Hovudstyringa kunne ikkje starte. Du kan framleis dra for å rotere.");
    }
  }

  private initializeWorker() {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker("/pointcloud/vision/head-worker.js?v=1");
      this.worker = worker;
      const timeout = window.setTimeout(() => finish(new Error("Worker timeout")), 25000);
      const finish = (error?: Error) => {
        window.clearTimeout(timeout);
        this.cancelInitialization = null;
        if (error) reject(error); else resolve();
      };
      this.cancelInitialization = () => finish(new Error("Cancelled"));
      worker.onerror = () => {
        if (this.stopped) return;
        finish(new Error("Worker failed"));
        this.fail();
      };
      worker.onmessage = ({ data }) => {
        if (this.stopped) return;
        if (data.type === "ready") { finish(); return; }
        if (data.type === "error") { finish(new Error("Detection failed")); this.fail(); return; }
        if (data.type !== "face") return;
        this.busy = false;
        this.interval = Math.min(180, Math.max(66, (performance.now() - this.sentAt) * 1.35));
        this.processFace(data.face as Face | null);
      };
      worker.postMessage({ type: "init" });
    });
  }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.stopped || document.hidden) return;
    if (this.busy && now - this.sentAt > 5000) { this.fail(); return; }
    if (now - this.lastSeen > 500 && this.state === "tracking") {
      this.changeState("searching");
      this.events.pose(null);
    }
    if (!this.busy && now - this.lastSent >= this.interval && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.busy = true;
      this.sentAt = this.lastSent = now;
      this.lastVideoTime = this.video.currentTime;
      void this.sendFrame(now);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private async sendFrame(timestamp: number) {
    try {
      const image = await createImageBitmap(this.video);
      if (this.stopped || !this.worker) { image.close(); return; }
      try { this.worker.postMessage({ type: "frame", image, timestamp }, [image]); }
      catch (error) { image.close(); throw error; }
    } catch {
      this.busy = false;
      if (!this.stopped) this.fail();
    }
  }

  private processFace(face: Face | null) {
    if (!face || ![face.x, face.y, face.size].every(Number.isFinite) || face.size <= .02) {
      if (!this.baseline) this.samples = [];
      return;
    }
    this.lastSeen = performance.now();
    if (!this.baseline) {
      this.samples.push(face);
      if (this.samples.length < 7) return;
      const count = this.samples.length;
      this.baseline = this.samples.reduce((sum, value) => ({ x: sum.x + value.x / count, y: sum.y + value.y / count, size: sum.size + value.size / count }), { x: 0, y: 0, size: 0 });
      this.samples = [];
    }
    this.changeState("tracking");
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    this.events.pose({
      x: clamp(-(face.x - this.baseline.x) * 4),
      y: clamp(-(face.y - this.baseline.y) * 3.5),
      z: clamp((this.baseline.size / face.size - 1) * 2.5),
    });
  }

  recenter = () => {
    if (this.stopped) return;
    this.baseline = null;
    this.samples = [];
    this.lastVideoTime = -1;
    this.events.pose(null);
    this.changeState("calibrating");
  };

  private changeState(next: TrackingState) {
    if (this.state === next) return;
    this.state = next;
    this.events.state(next);
  }

  private onEnded = () => this.fail();

  private fail() {
    if (this.stopped) return;
    this.stop();
    this.events.error("Kamerastyringa stoppa.");
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.cancelInitialization?.();
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach(track => { track.removeEventListener("ended", this.onEnded); track.stop(); });
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeEventListener("resize", this.recenter);
    window.removeEventListener("orientationchange", this.recenter);
    this.baseline = null;
    this.samples = [];
    this.events.pose(null);
  }
}
