import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, RAMPS, clamp01 } from './common';

/**
 * Puls. Det som svingar sakte, forsterka.
 *
 * Kvar piksel (glatta over 8x8 arbeidspiksel, så støyen middlar seg ut) får to glidande snitt med ulik
 * tidskonstant, eit raskt og eit sakte. Skilnaden er det som skjer mellom dei to frekvensane: eit båndpass i tid,
 * per piksel. Det er Eulerian video magnification (Wu, Rubinstein, Shih, Guttag, Durand og Freeman, 2012): bandet
 * vert gonga opp og lagt oppå det vanlege biletet. Blodet skiftar fargen i huda med nokre få gråtrinn i takt med
 * hjartet, og då vert det synleg. Små rørsler ved kantar gjer det same.
 *
 * Talet er rytmen under sonden. Signalet derifrå går gjennom ein Fourier-sum over dei siste sekunda, og toppen er
 * slag i minuttet. Målaren viser kor ordna spekteret er: 1 minus Shannon-entropien til effektspekteret, delt på
 * det største han kan bli. Ein rein rytme er låg entropi i frekvens. Støy er flat, og høg.
 *
 * Forsterkinga skrur seg sjølv: ho held det typiske signalet på eit synleg nivå, så eit stille bilete får meir
 * gain og eit rørt får mindre. Kameraet kan ikkje skilje støy frå signal, så i eit tomt rom ser ein støyen.
 */
interface Rate {
	/** område og steg, i slag per minutt */
	lo: number;
	hi: number;
	step: number;
	/** vindauge i sekund */
	win: number;
	unit: string;
	/** største hopp som vert glatta, ellers byter ein verdi */
	tol: number;
}

interface Preset {
	/** knekkpunkt i Hz: bandet går frå lo til hi */
	lo: number;
	hi: number;
	/** 0 = forsterka bilete, 1 = signalkart (raudt opp, blått ned) */
	view: 0 | 1;
	/** oppvarming i sekund: så lenge tek det før dei glidande snitta har stilna */
	warm: number;
	/** ønska glatta amplitude etter forsterking */
	target: number;
	kmax: number;
	/** kor fort forsterkinga fylgjer, per bilete */
	agc: number;
	/** kor hardt signalet vert klemt inn i målaren */
	km: number;
	rate: Rate | null;
	label: string;
	note: string;
}

const PULSE: Rate = { lo: 42, hi: 180, step: 1, win: 8, unit: 'BPM', tol: 8 };
const PRESETS: Preset[] = [
	{
		lo: 0.8,
		hi: 3.0,
		view: 0,
		warm: 2.5,
		target: 0.03,
		kmax: 50,
		agc: 0.05,
		km: 120,
		rate: PULSE,
		label: 'PULS',
		note: 'Pulsen. Blodet farger huda nokre gråtrinn i takt med hjartet, her forsterka. Trykk på huda for å måle.'
	},
	{
		lo: 0.1,
		hi: 0.7,
		view: 0,
		warm: 8,
		target: 0.03,
		kmax: 60,
		agc: 0.012,
		km: 40,
		rate: { lo: 6, hi: 40, step: 0.5, win: 16, unit: '/MIN', tol: 3 },
		label: 'PUST',
		note: 'Pust. Alt som går opp og ned med eit drag. Trykk på brystet og hald roleg.'
	},
	{
		lo: 4,
		hi: 12,
		view: 0,
		warm: 0.8,
		target: 0.04,
		kmax: 40,
		agc: 0.08,
		km: 20,
		rate: null,
		label: 'SKJELV',
		note: 'Skjelving. Alt som dirrar fire til tolv gonger i sekundet vert synleg.'
	},
	{
		lo: 0.8,
		hi: 3.0,
		view: 1,
		warm: 2.5,
		target: 0.1,
		kmax: 250,
		agc: 0.05,
		km: 120,
		rate: PULSE,
		label: 'SIGNAL',
		note: 'Berre signalet. Raudt og blått går opp og ned i takt med pulsen.'
	}
];

const LOG_LO = -16.6;
const LOG_SPAN = 13.3;

const FS_BLUR = `
uniform sampler2D uSrc;
void main() {
	vec2 px = 1.0 / vec2(textureSize(uSrc, 0));
	vec4 acc = vec4(0.0);
	for (int j = 0; j < 4; j++) {
		for (int i = 0; i < 4; i++) {
			vec2 o2 = (vec2(float(i), float(j)) * 2.0 - 3.5) * px;
			acc += texture(uSrc, vUv + o2);
		}
	}
	o = acc / 16.0;
}`;

const FS_LP = `
uniform sampler2D uX;
uniform sampler2D uS;
uniform float uA;
void main() {
	vec4 x = texture(uX, vUv);
	vec4 s = texture(uS, vUv);
	o = s + (x - s) * uA;
}`;

const FS_BAND = `
uniform sampler2D uF;
uniform sampler2D uL;
uniform float uFade;
void main() {
	vec3 b = (texture(uF, vUv).rgb - texture(uL, vUv).rgb) * uFade;
	o = vec4(b, 1.0);
}`;

const FS_MAP = `
uniform sampler2D uBand;
uniform float uKm;
void main() {
	vec3 b = texture(uBand, vUv).rgb;
	float l = dot(b, vec3(0.2126, 0.7152, 0.0722));
	float s = l * uKm;
	float r = 0.5 + 0.5 * s / (1.0 + abs(s));
	float g = clamp((log2(max(abs(l), 1e-5)) - (${LOG_LO.toFixed(1)})) / ${LOG_SPAN.toFixed(1)}, 0.0, 1.0);
	o = vec4(r, g, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
${RAMPS}
uniform sampler2D uBand;
uniform float uK;
uniform int uView;
void main() {
	vec3 c = camera(vUv);
	vec3 b = texture(uBand, vUv).rgb * uK;
	vec3 col;
	if (uView == 0) {
		vec3 m = vec3(0.5);
		col = c + b * m / (m + abs(b));
	} else {
		float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
		float v = dot(b, vec3(0.2126, 0.7152, 0.0722));
		vec3 heat = v > 0.0 ? rampWarm(v) : rampCool(-v);
		col = vec3(L) * 0.32 + heat;
	}
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

/** Fourier-sum over eit glidande vindauge av prøvar, med ujamne tidspunkt. */
export class RateEstimator {
	private t: number[] = [];
	private v: number[] = [];
	/** glatta verdi som vert vist, 0 = ingen */
	shown = 0;
	/** siste kandidat, ukorrigert */
	cand = 0;
	/** 1 − normalisert spektral entropi, 0..1 */
	order = 0;
	/** toppen over medianen, i gonger */
	conf = 0;
	private same = 0;
	private miss = 0;

	reset() {
		this.t.length = 0;
		this.v.length = 0;
		this.shown = 0;
		this.cand = 0;
		this.order = 0;
		this.conf = 0;
		this.same = 0;
		this.miss = 0;
	}

	push(t: number, v: number, winSec: number) {
		this.t.push(t);
		this.v.push(v);
		const cut = t - winSec * 1000;
		let k = 0;
		while (k < this.t.length - 1 && this.t[k] < cut) k++;
		if (k > 0) {
			this.t.splice(0, k);
			this.v.splice(0, k);
		}
	}

	/** Reknar eit nytt estimat. Set shown, order og conf. */
	estimate(r: Rate, minConf = 9): void {
		const n = this.t.length;
		if (n < 24) return;
		const t0 = this.t[0];
		const span = (this.t[n - 1] - t0) / 1000;
		if (span < r.win * 0.7) return;
		// Hann-vindauge over tid, og vekta snitt vekk
		const w = new Float64Array(n);
		const tt = new Float64Array(n);
		let sw = 0;
		let sv = 0;
		for (let k = 0; k < n; k++) {
			tt[k] = (this.t[k] - t0) / 1000;
			w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * tt[k]) / span);
			sw += w[k];
			sv += w[k] * this.v[k];
		}
		const mean = sv / Math.max(sw, 1e-9);
		const nb = Math.floor((r.hi - r.lo) / r.step) + 1;
		const P = new Float64Array(nb);
		for (let b = 0; b < nb; b++) {
			const om = (2 * Math.PI * (r.lo + b * r.step)) / 60;
			let re = 0;
			let im = 0;
			for (let k = 0; k < n; k++) {
				const x = (this.v[k] - mean) * w[k];
				const ph = om * tt[k];
				re += x * Math.cos(ph);
				im += x * Math.sin(ph);
			}
			P[b] = re * re + im * im;
		}
		let j = 0;
		let tot = 0;
		for (let b = 0; b < nb; b++) {
			tot += P[b];
			if (P[b] > P[j]) j = b;
		}
		const med = Array.from(P).sort((a, b) => a - b)[nb >> 1];
		this.conf = P[j] / (med + 1e-30);
		let bpm = r.lo + j * r.step;
		if (j > 0 && j < nb - 1) {
			const a = P[j - 1];
			const c = P[j + 1];
			const d = a - 2 * P[j] + c;
			if (d < 0) bpm += (r.step * 0.5 * (a - c)) / d;
		}
		// Shannon-entropi over m uavhengige band. Ein rein tone fyller eitt eller to, støy fyller alle.
		const m = Math.max(4, Math.min(40, Math.round(((r.hi - r.lo) / 60) * span)));
		const G = new Float64Array(m);
		for (let b = 0; b < nb; b++) G[Math.min(m - 1, Math.floor((b * m) / nb))] += P[b];
		let H = 0;
		for (let g = 0; g < m; g++) {
			const p = G[g] / (tot + 1e-30);
			if (p > 1e-12) H -= p * Math.log2(p);
		}
		const Hn = H / Math.log2(m);
		this.order = clamp01((0.92 - Hn) / 0.5);

		if (this.conf >= minConf) {
			this.miss = 0;
			if (this.shown > 0 && Math.abs(bpm - this.shown) < r.tol) {
				this.shown += 0.35 * (bpm - this.shown);
				this.same = 0;
			} else if (Math.abs(bpm - this.cand) < r.tol) {
				// to like estimat på rad: byt
				if (++this.same >= 2) {
					this.shown = bpm;
					this.same = 0;
				}
			} else this.same = 0;
			this.cand = bpm;
		} else {
			this.same = 0;
			if (++this.miss >= 6) this.shown = 0;
		}
	}
}

export class Puls implements Setup {
	readonly info: SetupInfo = {
		id: 'puls',
		code: 'PUL',
		group: 'tid',
		name: 'Puls',
		blurb: 'Forsterkar det som svingar sakte. Pulsen din vert synleg som ei fargebølgje i huda.',
		how: 'Lene telefonen mot noko, og hald handa eller andletet roleg framfor. Trykk på huda for å måle. Trykk på talet nede til høgre for anna band.',
		needsFloat: true,
		probe: true,
		still: true
	};

	private xP!: Prog;
	private uP!: Prog;
	private bP!: Prog;
	private mP!: Prog;
	private dP!: Prog;
	private x!: Target;
	private fast: Target[] = [];
	private slow: Target[] = [];
	private i = 0;
	private band!: Target;
	private map!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private fresh = true;
	private age = 0;
	private last = -1;
	private logK = Math.log(30);
	private seen = 0;
	private sig = 0;
	private peak = 0.02;
	private lastEst = 0;
	private rate = new RateEstimator();
	private eN = new Ease();
	private eG = new Ease();
	private amp = 0;

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.xP = g.prog('pul.blur', FS_BLUR);
		this.uP = g.prog('pul.lp', FS_LP);
		this.bP = g.prog('pul.band', FS_BAND);
		this.mP = g.prog('pul.map', FS_MAP);
		this.dP = g.prog('pul.draw', FS_DRAW);
		const f = g.floatFmt();
		this.x = g.target(ctx.w, ctx.h, f, false);
		this.fast = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.slow = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.band = g.target(ctx.w, ctx.h, g.F16, true);
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g, 2);
		this.restart();
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	private restart() {
		this.fresh = true;
		this.age = 0;
		this.rate.reset();
		this.logK = Math.log(this.pre.kmax * 0.5);
		this.peak = 0.02;
		this.eN.reset();
		this.eG.reset();
	}

	cycle(): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.restart();
		return this.pre.note;
	}

	private lp(ctx: Ctx, set: Target[], a: number) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.to(set[1 - this.i]);
		g.use(this.uP);
		g.sampler(this.uP, 'uX', 0, this.x.tex);
		g.sampler(this.uP, 'uS', 1, set[this.i].tex);
		gl.uniform1f(this.uP.u('uA'), a);
		g.quad();
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const pre = this.pre;
		const dt = this.last < 0 ? 1 / 30 : Math.min(0.12, Math.max(0.008, (ctx.now - this.last) / 1000));
		this.last = ctx.now;

		// 1. glatta inngang, i flyttal
		g.to(this.x);
		g.use(this.xP);
		g.sampler(this.xP, 'uSrc', 0, ctx.cur.tex);
		g.quad();

		// 2. to glidande snitt med kvar sin frekvens
		const fresh = this.fresh;
		this.fresh = false;
		this.age = fresh ? 0 : this.age + dt;
		this.lp(ctx, this.fast, fresh ? 1 : 1 - Math.exp(-2 * Math.PI * pre.hi * dt));
		this.lp(ctx, this.slow, fresh ? 1 : 1 - Math.exp(-2 * Math.PI * pre.lo * dt));
		this.i ^= 1;

		// 3. bandet er skilnaden. Oppvarming: dei første sekunda er filtera ikkje stilna.
		const warm = pre.warm;
		const fade = Math.pow(clamp01(this.age / warm), 2);
		g.to(this.band);
		g.use(this.bP);
		g.sampler(this.bP, 'uF', 0, this.fast[this.i].tex);
		g.sampler(this.bP, 'uL', 1, this.slow[this.i].tex);
		gl.uniform1f(this.bP.u('uFade'), fade);
		g.quad();

		// 4. kart for målarane: signal med fortegn, og log-amplitude
		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uBand', 0, this.band.tex);
		gl.uniform1f(this.mP.u('uKm'), pre.km);
		g.quad();
		this.meter.run(ctx, this.map, 0, 1);

		// 5. glatta forsterking som held det typiske signalet på eit synleg nivå
		const m = this.meter;
		this.amp = Math.pow(2, m.globalB * LOG_SPAN + LOG_LO);
		const want = Math.min(pre.kmax, Math.max(1, pre.target / this.amp));
		this.logK += (Math.log(want) - this.logK) * pre.agc;

		// 6. nytt prøvepunkt frå sonden → frekvens
		if (m.count !== this.seen) {
			this.seen = m.count;
			this.sig = m.spotA - 0.5;
			this.peak = Math.max(Math.abs(this.sig), this.peak * 0.985);
			if (pre.rate && this.age > warm) {
				this.rate.push(ctx.now, this.sig, pre.rate.win);
				if (ctx.now - this.lastEst > 500) {
					this.lastEst = ctx.now;
					this.rate.estimate(pre.rate);
				}
			}
		}
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uBand', 0, this.band.tex);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.dP.u('uK'), Math.exp(this.logK));
		gl.uniform1i(this.dP.u('uView'), this.pre.view);
		g.quad();
	}

	meters(): Meters {
		const pre = this.pre;
		const r = this.rate;
		const m = this.meter;
		const K = Math.round(Math.exp(this.logK));
		const needle = this.eN.step(0.5 + 0.45 * Math.max(-1, Math.min(1, this.sig / Math.max(this.peak, 0.01))), 0.5);
		if (pre.rate) {
			return {
				gauge: this.eG.step(r.order, 0.2),
				ruler: clamp01(needle),
				value: r.shown > 0 ? String(Math.round(r.shown)) : '--',
				chip: pre.rate.unit,
				params: `${pre.label} X${K}`,
				rulerEnds: ['−', '+']
			};
		}
		return {
			gauge: this.eG.step(m.globalB, 0.2),
			ruler: clamp01(m.spotB),
			value: (this.amp * 255).toFixed(2),
			chip: 'AMP',
			params: `${pre.label} X${K}`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.x?.del();
		this.fast.forEach((t) => t.del());
		this.slow.forEach((t) => t.del());
		this.band?.del();
		this.map?.del();
		this.meter?.dispose();
	}
}
