import { Gfx, Reader, type Prog, type Target } from './gl';
import type { Ctx, Factory, Meters, Setup, SetupInfo } from './types';

export interface EngineEvents {
	onMeters(m: Meters): void;
	onSetup(info: SetupInfo, index: number, count: number): void;
	onStall?(): void;
	onFatal?(e: Error): void;
}

/** Lengste side i arbeidsbiletet. Kvar piksel her er ein «mikrotilstand» som oppsetta tel på. */
const WORK_LONG = 640;
/** Tak på pikslar i lerretet, så A18 ikkje svettar for ingenting. */
const MAX_CANVAS_PIXELS = 1_500_000;

const BLIT = `
uniform sampler2D uVideo;
uniform vec2 uCover;
void main() {
	vec2 uv = (vUv - 0.5) * uCover + 0.5;
	vec3 c = texture(uVideo, uv).rgb;
	o = vec4(c, dot(c, vec3(0.2126, 0.7152, 0.0722)));
}`;

export class Engine {
	gfx!: Gfx;
	private reader!: Reader;
	private blit!: Prog;
	private videoTex!: WebGLTexture;
	private vw = 0;
	private vh = 0;
	private a!: Target;
	private b!: Target;
	private ww = 0;
	private wh = 0;
	private sw = 0;
	private sh = 0;
	private infos: SetupInfo[];
	private ok: boolean[];
	private idx = 0;
	private setup: Setup | null = null;
	private probe: [number, number] = [0.5, 0.5]; // 0..1, origo nede til venstre
	private running = false;
	private vfc = 0;
	private raf = 0;
	private frameNo = 0;
	private t0 = performance.now();
	private lastFrameAt = 0;
	private lastMeters = 0;
	private lastVideoTime = -1;
	private fpsN = 0;
	private fpsT = 0;
	fps = 0;
	private lost = false;

	constructor(
		private canvas: HTMLCanvasElement,
		private video: HTMLVideoElement,
		private factories: Factory[],
		private ev: EngineEvents
	) {
		this.infos = factories.map((f) => f().info);
		this.ok = this.infos.map(() => true);
		this.build();
		canvas.addEventListener('webglcontextlost', this.onLost as EventListener, false);
		canvas.addEventListener('webglcontextrestored', this.onRestored as EventListener, false);
	}

	/* ---------- oppsett ---------- */

	private build() {
		this.gfx = new Gfx(this.canvas);
		const g = this.gfx;
		this.reader = new Reader(g.gl);
		this.blit = g.prog('blit', BLIT);
		this.videoTex = g.texture(2, 2, g.U8, true);
		this.vw = this.vh = 0;
		this.ok = this.infos.map((i) => !i.needsFloat || g.hasF16);
	}

	get count() {
		return this.infos.length;
	}
	get index() {
		return this.idx;
	}
	get info(): SetupInfo {
		return this.infos[this.idx];
	}
	get webgl() {
		return {
			f32: this.gfx.hasF32,
			f16: this.gfx.hasF16,
			maxTex: this.gfx.maxTex,
			work: [this.ww, this.wh] as [number, number],
			canvas: [this.sw, this.sh] as [number, number],
			video: [this.vw, this.vh] as [number, number]
		};
	}

	/** Set lerretstorleik (CSS-piksel). Byggjer arbeidsmåla på nytt og startar oppsettet om. */
	resize(cssW: number, cssH: number, dpr: number) {
		let d = Math.max(1, Math.min(dpr, 3));
		while (cssW * d * cssH * d > MAX_CANVAS_PIXELS && d > 1) d -= 0.25;
		const sw = Math.max(2, Math.round(cssW * d));
		const sh = Math.max(2, Math.round(cssH * d));
		if (sw === this.sw && sh === this.sh && this.a) return;
		this.sw = this.canvas.width = sw;
		this.sh = this.canvas.height = sh;
		const long = Math.max(sw, sh);
		const k = WORK_LONG / long;
		// delbart med 8: då er mipmap-nivå 3 eksakte 8x8-snitt (brukt av målarane)
		this.ww = Math.max(16, Math.round((sw * k) / 8) * 8);
		this.wh = Math.max(16, Math.round((sh * k) / 8) * 8);
		this.rebuildTargets();
	}

	private rebuildTargets() {
		const g = this.gfx;
		this.a?.del();
		this.b?.del();
		this.a = g.target(this.ww, this.wh, g.U8, true);
		this.b = g.target(this.ww, this.wh, g.U8, true);
		this.startSetup();
	}

	private startSetup() {
		this.setup?.dispose();
		this.setup = null;
		if (!this.a) return;
		let s: Setup | null = null;
		for (let k = 0; k < this.count && !s; k++) {
			const i = (this.idx + k) % this.count;
			if (!this.ok[i]) continue;
			try {
				const c = this.factories[i]();
				c.init(this.ctx());
				s = c;
				this.idx = i;
			} catch (e) {
				console.error('oppsett feila', this.infos[i].id, e);
				this.ok[i] = false;
			}
		}
		if (!s) {
			this.ev.onFatal?.(new Error('Ingen oppsett kunne starte'));
			return;
		}
		this.setup = s;
		this.ev.onSetup(s.info, this.idx, this.count);
		this.ev.onMeters(s.meters());
	}

	go(i: number): void {
		const n = this.count;
		i = ((i % n) + n) % n;
		if (!this.ok[i]) {
			this.next();
			return;
		}
		this.idx = i;
		this.startSetup();
	}

	next(): void {
		for (let k = 1; k <= this.count; k++) {
			const i = (this.idx + k) % this.count;
			if (this.ok[i]) {
				this.go(i);
				return;
			}
		}
	}

	setProbe(x: number, y: number) {
		this.probe = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, 1 - y))];
	}

	/** Trykk i skjermkoordinatar 0..1 (origo øvst til venstre). true viss oppsettet tok det. */
	tap(x: number, y: number): boolean {
		const c = this.ctx();
		this.setProbe(x, y);
		return !!this.setup?.tap?.(c, x, 1 - y);
	}

	/* ---------- køyring ---------- */

	start() {
		if (this.running) return;
		this.running = true;
		this.lastFrameAt = performance.now();
		this.schedule();
	}

	stop() {
		this.running = false;
		const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
		if (this.vfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.vfc);
		cancelAnimationFrame(this.raf);
		this.vfc = this.raf = 0;
	}

	private schedule() {
		if (!this.running) return;
		const v = this.video as HTMLVideoElement & {
			requestVideoFrameCallback?: (cb: (now: number) => void) => number;
		};
		if (v.requestVideoFrameCallback) {
			this.vfc = v.requestVideoFrameCallback(this.loop);
			// vaktpost: viss ingen bilete kjem (pausa video), hald likevel tilstanden levande
			if (!this.raf) this.raf = requestAnimationFrame(this.watch);
		} else {
			this.raf = requestAnimationFrame(this.loopRaf);
		}
	}

	private loop = (now: number) => {
		if (!this.running) return;
		this.schedule();
		this.process(now);
	};

	private loopRaf = (now: number) => {
		if (!this.running) return;
		this.schedule();
		const t = this.video.currentTime;
		if (t === this.lastVideoTime) return;
		this.lastVideoTime = t;
		this.process(now);
	};

	private watch = () => {
		this.raf = 0;
		if (!this.running) return;
		const now = performance.now();
		if (now - this.lastFrameAt > 2500) {
			this.lastFrameAt = now;
			this.ev.onStall?.();
		}
		this.raf = requestAnimationFrame(this.watch);
	};

	private ctx(): Ctx {
		return {
			gfx: this.gfx,
			video: this.videoTex,
			cover: this.cover(),
			w: this.ww,
			h: this.wh,
			cur: this.a,
			prev: this.b,
			probe: this.probe,
			sw: this.sw,
			sh: this.sh,
			frameNo: this.frameNo,
			now: performance.now() - this.t0,
			read: (t, x, y, w, h, cb) => this.reader.request(t, x, y, w, h, cb)
		};
	}

	private cover(): [number, number] {
		if (!this.vw || !this.vh || !this.sw) return [1, 1];
		const va = this.vw / this.vh;
		const sa = this.sw / this.sh;
		return va > sa ? [sa / va, 1] : [1, va / sa];
	}

	private process(_now: number) {
		const v = this.video;
		if (this.lost || !this.setup || !this.a) return;
		if (v.readyState < 2 || v.videoWidth === 0) return;
		const g = this.gfx;
		const gl = g.gl;
		const t = performance.now();
		this.lastFrameAt = t;

		// 1. kamerabilete til tekstur
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		try {
			if (v.videoWidth !== this.vw || v.videoHeight !== this.vh) {
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
				this.vw = v.videoWidth;
				this.vh = v.videoHeight;
			} else {
				gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
			}
		} catch (e) {
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			console.warn('video-opplasting feila', e);
			return;
		}
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

		const cover = this.cover();

		// 2. arbeidsbilete: dekk skjermen, luma i alfa
		g.to(this.a);
		g.use(this.blit);
		g.sampler(this.blit, 'uVideo', 0, this.videoTex);
		gl.uniform2f(this.blit.u('uCover'), cover[0], cover[1]);
		g.quad();

		// 3. oppsettet
		const ctx = this.ctx();
		ctx.cover = cover;
		try {
			this.setup.frame(ctx);
			g.to(null, this.sw, this.sh);
			this.setup.draw(ctx);
		} catch (e) {
			console.error('oppsett feila i drift', this.setup.info.id, e);
			this.ok[this.idx] = false;
			this.next();
			return;
		}

		// 4. bytt rolle på måla
		const x = this.a;
		this.a = this.b;
		this.b = x;

		this.reader.poll();
		this.frameNo++;

		// 5. målarar til HUD-en, ~8 Hz
		if (t - this.lastMeters > 120) {
			this.lastMeters = t;
			this.ev.onMeters(this.setup.meters());
		}

		this.fpsN++;
		if (t - this.fpsT > 1000) {
			this.fps = (this.fpsN * 1000) / (t - this.fpsT);
			this.fpsN = 0;
			this.fpsT = t;
		}
	}

	/* ---------- livssyklus ---------- */

	private onLost = (e: Event) => {
		e.preventDefault();
		this.lost = true;
	};

	private onRestored = () => {
		this.lost = false;
		try {
			this.setup = null;
			this.sw = this.sh = 0;
			this.build();
			const w = this.canvas.clientWidth || window.innerWidth;
			const h = this.canvas.clientHeight || window.innerHeight;
			this.resize(w, h, window.devicePixelRatio || 1);
		} catch (e) {
			this.ev.onFatal?.(e as Error);
		}
	};

	dispose() {
		this.stop();
		this.setup?.dispose();
		this.canvas.removeEventListener('webglcontextlost', this.onLost as EventListener);
		this.canvas.removeEventListener('webglcontextrestored', this.onRestored as EventListener);
	}

	/** Til feilsøking og testar. */
	debug() {
		return {
			setup: this.info.id,
			index: this.idx,
			fps: Math.round(this.fps * 10) / 10,
			frames: this.frameNo,
			meters: this.setup?.meters() ?? null,
			webgl: this.webgl
		};
	}
}
