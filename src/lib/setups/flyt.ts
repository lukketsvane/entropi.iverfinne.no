import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, Reducer, clamp01 } from './common';

/**
 * Flyt. Kvar piksel får ein fartsvektor: kor mange piksel innhaldet flytta seg sidan førre bilete.
 *
 * Metode: Lucas-Kanade på ein pyramide med fire nivå (mipmap av lysstyrken), frå grovt til fint. På kvart nivå vert
 * førre bilete vridd med flyten så langt, og resten vert funne ved å løyse 2×2-likninga  S·d = −b  i eit 7×7-vindauge
 * (S = Σ ∇I·∇Iᵀ, b = Σ ∇I·∂I/∂t). Då klarer han fart opp til nesten 30 piksel per bilete.
 *
 * Talet er retningsentropien: histogram over åtte retningar for dei pikslane som rører seg, H = −Σ p·log2 p, 0 til 3 bit.
 * Alle går same veg (panorering, ei hand som går forbi): 0 bit. Blad i vind, vatn, eit publikum: opp mot 3 bit.
 * Det er ei grovkorning av rørsle: åtte retningar, ingen fart. Den skjuler kor fort, og viser berre kor ordna.
 */
const LEVELS = 5;
/** iterasjonar per nivå, indeks = nivå (0 er finast) */
const ITERS = [2, 2, 2, 3, 5];
const R = 3;
const SIGMA = 1.8;
/** Under dette (piksel per bilete) er det støy, ikkje rørsle. */
const FLOOR = 0.4;

const WN = (() => {
	let s = 0;
	for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) s += Math.exp(-(i * i + j * j) / (2 * SIGMA * SIGMA));
	return s;
})();

const FS_LUM = `
uniform sampler2D uF;
void main() {
	vec3 c = texture(uF, vUv).rgb;
	o = vec4(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 0.0, 1.0);
}`;

/** Gradient og tidsdifferanse etter at førre bilete er vridd med flyten så langt. */
const FS_D = `
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform sampler2D uG;
uniform float uGs;
uniform float uLod;
uniform vec2 uTexel;
float C(vec2 uv) { return textureLod(uCur, uv, uLod).r; }
float P(vec2 uv) { return textureLod(uPrev, uv, uLod).r; }
void main() {
	vec2 g = uGs * texture(uG, vUv).xy;
	vec2 w = vUv - g * uTexel;
	vec2 dx = vec2(uTexel.x, 0.0);
	vec2 dy = vec2(0.0, uTexel.y);
	float gx = 0.25 * (C(vUv + dx) - C(vUv - dx) + P(w + dx) - P(w - dx));
	float gy = 0.25 * (C(vUv + dy) - C(vUv - dy) + P(w + dy) - P(w - dy));
	o = vec4(gx, gy, C(vUv) - P(w), 1.0);
}`;

/** Løys for resten, legg han til flyten. G = uGs·G_inn + d. Alfa/blå: kor godt bestemt (minste eigenverdi). */
const FS_S = `
uniform sampler2D uD;
uniform sampler2D uG;
uniform float uGs;
uniform vec2 uTexel;
uniform float uLam;
uniform float uStep;
void main() {
	float sxx = 0.0, sxy = 0.0, syy = 0.0, sxt = 0.0, syt = 0.0;
	for (int j = -${R}; j <= ${R}; j++) {
		for (int i = -${R}; i <= ${R}; i++) {
			vec3 d = texture(uD, vUv + vec2(float(i), float(j)) * uTexel).xyz;
			float w = exp(-float(i * i + j * j) / ${(2 * SIGMA * SIGMA).toFixed(3)}) / ${WN.toFixed(4)};
			sxx += w * d.x * d.x;
			sxy += w * d.x * d.y;
			syy += w * d.y * d.y;
			sxt += w * d.x * d.z;
			syt += w * d.y * d.z;
		}
	}
	float a = sxx + uLam;
	float c = syy + uLam;
	float det = a * c - sxy * sxy;
	vec2 dG = vec2(-(c * sxt - sxy * syt), -(a * syt - sxy * sxt)) / max(det, 1e-9);
	dG = clamp(dG, vec2(-uStep), vec2(uStep));
	float conf = 0.5 * (sxx + syy - sqrt((sxx - syy) * (sxx - syy) + 4.0 * sxy * sxy));
	vec2 G = uGs * texture(uG, vUv).xy + dG;
	o = vec4(G, conf, 1.0);
}`;

/** Fin flyt til visinga, med mipmap. */
const FS_COPY = `
uniform sampler2D uG;
void main() { o = vec4(texture(uG, vUv).xy, 0.0, 1.0); }`;

const FS_HIST = `
uniform sampler2D uFlow;
uniform vec2 uMean;
uniform float uPart;
void main() {
	vec2 raw = texture(uFlow, vUv).xy;
	vec2 f = raw - uMean;
	float mag = length(f);
	float w = smoothstep(${FLOOR.toFixed(2)}, ${(FLOOR + 0.7).toFixed(2)}, mag);
	float k = floor(mod(atan(f.y, f.x) / 6.2831853 * 8.0 + 8.5, 8.0));
	if (uPart < 0.5) o = vec4(equal(vec4(k), vec4(0.0, 1.0, 2.0, 3.0))) * w;
	else if (uPart < 1.5) o = vec4(equal(vec4(k), vec4(4.0, 5.0, 6.0, 7.0))) * w;
	else o = vec4(w, clamp(0.5 + raw.x / 64.0, 0.0, 1.0), clamp(0.5 + raw.y / 64.0, 0.0, 1.0), clamp(mag / 8.0, 0.0, 1.0));
}`;

const HSV = `
vec3 hsv(float h) {
	return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}`;

const FS_INK = `${HSV}
uniform sampler2D uInk;
uniform sampler2D uFlow;
uniform vec2 uMean;
uniform vec2 uTexel;
uniform float uDecay;
void main() {
	vec2 f = texture(uFlow, vUv).xy - uMean;
	vec4 ink = texture(uInk, vUv - f * uTexel);
	float m = smoothstep(${FLOOR.toFixed(2)}, 2.5, length(f));
	vec3 hue = hsv(atan(f.y, f.x) / 6.2831853);
	// blanding, ikkje sum: fargane held seg metta og vert ikkje kvite
	float k = m * 0.38;
	vec3 rgb = mix(ink.rgb, hue, k);
	float a = max(ink.a * uDecay, m);
	o = vec4(rgb, a);
}`;

const FS_COLOR = `${COVER_VIDEO}${HSV}
uniform sampler2D uFlow;
uniform vec2 uMean;
void main() {
	vec2 f = texture(uFlow, vUv).xy - uMean;
	vec3 cam = camera(vUv);
	float L = dot(cam, vec3(0.2126, 0.7152, 0.0722));
	float m = smoothstep(${FLOOR.toFixed(2)}, 2.0, length(f));
	vec3 hue = hsv(atan(f.y, f.x) / 6.2831853);
	vec3 col = cam * 0.34 * (1.0 - 0.7 * m) + hue * m * (0.35 + 0.95 * L);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

const FS_INKDRAW = `${COVER_VIDEO}
uniform sampler2D uInk;
void main() {
	vec4 ink = texture(uInk, vUv);
	vec3 cam = camera(vUv);
	float L = dot(cam, vec3(0.2126, 0.7152, 0.0722));
	float a = smoothstep(0.02, 0.9, ink.a);
	vec3 col = mix(cam * 0.30, ink.rgb * (0.45 + 0.85 * L), a);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

/** Pilnett: ei pil i midten av kvar rute, lengd = fart. */
const FS_ARROWS = `${COVER_VIDEO}
uniform sampler2D uFlow;
uniform vec2 uMean;
uniform vec2 uSize;
uniform float uCell;
uniform float uGain;
float seg(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a;
	vec2 ba = b - a;
	float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	return length(pa - ba * h);
}
void main() {
	vec2 px = vUv * uSize;
	vec2 cell = floor(px / uCell);
	vec2 c = (cell + 0.5) * uCell;
	vec2 f = textureLod(uFlow, c / uSize, 2.0).xy - uMean;
	float mag = length(f);
	vec3 cam = camera(vUv);
	vec3 col = cam * 0.30;
	float len = min(mag * uGain, uCell * 1.35);
	vec2 dir = mag > 1e-4 ? f / mag : vec2(1.0, 0.0);
	vec2 a = c - dir * len * 0.5;
	vec2 b = c + dir * len * 0.5;
	float d = seg(px, a, b);
	vec2 n = vec2(-dir.y, dir.x);
	float hl = min(len * 0.38, uCell * 0.34);
	d = min(d, seg(px, b, b - dir * hl + n * hl * 0.55));
	d = min(d, seg(px, b, b - dir * hl - n * hl * 0.55));
	float on = smoothstep(${FLOOR.toFixed(2)}, ${(FLOOR + 0.8).toFixed(2)}, mag);
	float dot0 = 1.0 - smoothstep(0.8, 1.8, length(px - c));
	float ink = (1.0 - smoothstep(0.6, 1.5, d)) * on + dot0 * 0.32 * (1.0 - on);
	col = mix(col, vec3(1.0), ink);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

interface Preset {
	label: string;
	note: string;
	/** trekk frå gjennomsnittsrørsla (kamerarørsle) */
	rel: boolean;
}

const PRESETS: Preset[] = [
	{ label: 'FARGE', note: 'Farge er retning, lys er fart. Det som står stille er mørkt.', rel: false },
	{ label: 'BLEKK', note: 'Fargeblekk som følgjer rørsla. Spora fell av over eit sekund.', rel: false },
	{ label: 'PILER', note: 'Ei pil per rute. Lengda er kor langt innhaldet flytta seg sidan førre bilete.', rel: false },
	{ label: 'RELATIV', note: 'Same som farge, men gjennomsnittsrørsla er trekt frå. Då er det berre det som rører seg mot resten som lyser.', rel: true }
];

export class Flyt implements Setup {
	readonly info: SetupInfo = {
		id: 'flyt',
		code: 'FLY',
		group: 'tid',
		name: 'Flyt',
		blurb: 'Kvar piksel får ein fartsvektor. Talet er kor ordna rørsla er, i bit.',
		how: 'Veiv med handa, pan med telefonen, peik mot blad i vind. Alle same veg gir null bit, rot gir tre. Trykk på talet nede til høgre: farge, blekk, piler.',
		needsFloat: true,
		probe: false
	};

	private pLum!: Prog;
	private pD!: Prog;
	private pS!: Prog;
	private pCopy!: Prog;
	private pHist!: Prog;
	private pInk!: Prog;
	private pColor!: Prog;
	private pInkDraw!: Prog;
	private pArrows!: Prog;
	private lum: Target[] = [];
	private li = 0;
	private G: Target[][] = [];
	private gi: number[] = [];
	private D: Target[] = [];
	private zero!: Target;
	private flow!: Target;
	private ink: Target[] = [];
	private ii = 0;
	private maps: Target[] = [];
	private red!: Reducer;
	private n = 0;
	private pr = 0;
	private mean: [number, number] = [0, 0];
	private eH = new Ease();
	private eS = new Ease();
	private lw: number[] = [];
	private lh: number[] = [];

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.pLum = g.prog('fly.lum', FS_LUM);
		this.pD = g.prog('fly.d', FS_D);
		this.pS = g.prog('fly.s', FS_S);
		this.pCopy = g.prog('fly.copy', FS_COPY);
		this.pHist = g.prog('fly.hist', FS_HIST);
		this.pInk = g.prog('fly.ink', FS_INK);
		this.pColor = g.prog('fly.color', FS_COLOR);
		this.pInkDraw = g.prog('fly.inkdraw', FS_INKDRAW);
		this.pArrows = g.prog('fly.arrows', FS_ARROWS);
		this.lum = [g.target(ctx.w, ctx.h, g.F16, true, true), g.target(ctx.w, ctx.h, g.F16, true, true)];
		for (let L = 0; L < LEVELS; L++) {
			const w = Math.max(8, Math.round(ctx.w / 2 ** L));
			const h = Math.max(8, Math.round(ctx.h / 2 ** L));
			this.lw[L] = w;
			this.lh[L] = h;
			this.G[L] = [g.target(w, h, g.F16, true), g.target(w, h, g.F16, true)];
			this.D[L] = g.target(w, h, g.F16, true);
			this.gi[L] = 0;
		}
		this.zero = g.target(1, 1, g.F16, true);
		g.to(this.zero);
		g.gl.clearColor(0, 0, 0, 0);
		g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		this.flow = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.ink = [g.target(ctx.w, ctx.h, g.F16, true), g.target(ctx.w, ctx.h, g.F16, true)];
		for (const t of [...this.ink, this.flow]) {
			g.to(t);
			g.gl.clearColor(0, 0, 0, 0);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
		this.maps = [0, 1, 2].map(() => g.target(ctx.w, ctx.h, g.F16, true, true));
		this.red = new Reducer(g, 12);
		this.n = 0;
	}

	/**
	 * Rørsla som skal trekkjast frå (RELATIV). Berre samanhengande rørsle over ~1 piksel per bilete tel som
	 * kamerarørsle: ei hand i biletet med eit stille kamera gir eit lite snitt som ikkje skal skyve heile biletet.
	 */
	private sub(): [number, number] {
		if (!PRESETS[this.pr].rel) return [0, 0];
		const mag = Math.hypot(this.mean[0], this.mean[1]);
		const k = clamp01((mag - 0.5) / 1.0);
		return [this.mean[0] * k, this.mean[1] * k];
	}

	cycle(ctx: Ctx): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		const g = ctx.gfx;
		for (const t of this.ink) {
			g.to(t);
			g.gl.clearColor(0, 0, 0, 0);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
		this.eH.reset();
		return PRESETS[this.pr].note;
	}

	private pass(ctx: Ctx, t: Target, p: Prog, set: () => void) {
		const g = ctx.gfx;
		g.to(t);
		g.use(p);
		set();
		g.quad();
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const lc = this.lum[this.li];
		const lp = this.lum[1 - this.li];

		// 1. lysstyrke med mipmap
		this.pass(ctx, lc, this.pLum, () => g.sampler(this.pLum, 'uF', 0, ctx.cur.tex));
		g.mipmap(lc);

		// 2. flyt, grovt til fint
		if (this.n > 0) {
			let src: WebGLTexture = this.zero.tex;
			let scale = 0;
			for (let L = LEVELS - 1; L >= 0; L--) {
				const texel: [number, number] = [1 / this.lw[L], 1 / this.lh[L]];
				for (let it = 0; it < ITERS[L]; it++) {
					this.pass(ctx, this.D[L], this.pD, () => {
						g.sampler(this.pD, 'uCur', 0, lc.tex);
						g.sampler(this.pD, 'uPrev', 1, lp.tex);
						g.sampler(this.pD, 'uG', 2, src);
						gl.uniform1f(this.pD.u('uGs'), scale);
						gl.uniform1f(this.pD.u('uLod'), L);
						gl.uniform2f(this.pD.u('uTexel'), texel[0], texel[1]);
					});
					const dst = this.G[L][1 - this.gi[L]];
					this.pass(ctx, dst, this.pS, () => {
						g.sampler(this.pS, 'uD', 0, this.D[L].tex);
						g.sampler(this.pS, 'uG', 1, src);
						gl.uniform1f(this.pS.u('uGs'), scale);
						gl.uniform2f(this.pS.u('uTexel'), texel[0], texel[1]);
						gl.uniform1f(this.pS.u('uLam'), 4e-4);
						gl.uniform1f(this.pS.u('uStep'), 2.5);
					});
					this.gi[L] ^= 1;
					src = dst.tex;
					scale = 1;
				}
				scale = 2;
			}
			this.pass(ctx, this.flow, this.pCopy, () => g.sampler(this.pCopy, 'uG', 0, src));
			g.mipmap(this.flow);
		}
		this.li ^= 1;
		this.n++;

		// 3. målingar
		const mean = this.sub();
		for (let part = 0; part < 3; part++) {
			this.pass(ctx, this.maps[part], this.pHist, () => {
				g.sampler(this.pHist, 'uFlow', 0, this.flow.tex);
				gl.uniform2f(this.pHist.u('uMean'), mean[0], mean[1]);
				gl.uniform1f(this.pHist.u('uPart'), part);
			});
		}
		this.red.run(ctx, this.maps);
		const v = this.red.v;
		this.mean = [(v[9] - 0.5) * 64, (v[10] - 0.5) * 64];

		// 4. blekk
		if (this.pr === 1) {
			const dst = this.ink[1 - this.ii];
			this.pass(ctx, dst, this.pInk, () => {
				g.sampler(this.pInk, 'uInk', 0, this.ink[this.ii].tex);
				g.sampler(this.pInk, 'uFlow', 1, this.flow.tex);
				gl.uniform2f(this.pInk.u('uMean'), mean[0], mean[1]);
				gl.uniform2f(this.pInk.u('uTexel'), 1 / ctx.w, 1 / ctx.h);
				gl.uniform1f(this.pInk.u('uDecay'), 0.965);
			});
			this.ii ^= 1;
		}
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const mean = this.sub();
		if (this.pr === 1) {
			g.use(this.pInkDraw);
			g.sampler(this.pInkDraw, 'uInk', 0, this.ink[this.ii].tex);
			g.sampler(this.pInkDraw, 'uVideo', 1, ctx.video);
			gl.uniform2f(this.pInkDraw.u('uCover'), ctx.cover[0], ctx.cover[1]);
		} else if (this.pr === 2) {
			g.use(this.pArrows);
			g.sampler(this.pArrows, 'uFlow', 0, this.flow.tex);
			g.sampler(this.pArrows, 'uVideo', 1, ctx.video);
			gl.uniform2f(this.pArrows.u('uCover'), ctx.cover[0], ctx.cover[1]);
			gl.uniform2f(this.pArrows.u('uMean'), mean[0], mean[1]);
			gl.uniform2f(this.pArrows.u('uSize'), ctx.sw, ctx.sh);
			const k = ctx.sw / ctx.w; // canvas-piksel per arbeidspiksel
			gl.uniform1f(this.pArrows.u('uCell'), Math.round(ctx.sw / 16));
			gl.uniform1f(this.pArrows.u('uGain'), 3 * k);
		} else {
			g.use(this.pColor);
			g.sampler(this.pColor, 'uFlow', 0, this.flow.tex);
			g.sampler(this.pColor, 'uVideo', 1, ctx.video);
			gl.uniform2f(this.pColor.u('uCover'), ctx.cover[0], ctx.cover[1]);
			gl.uniform2f(this.pColor.u('uMean'), mean[0], mean[1]);
		}
		g.quad();
	}

	meters(): Meters {
		const v = this.red.v;
		let tot = 0;
		for (let k = 0; k < 8; k++) tot += v[k];
		let h = 0;
		if (tot > 0.0015) {
			for (let k = 0; k < 8; k++) {
				const p = v[k] / tot;
				if (p > 1e-6) h -= p * Math.log2(p);
			}
		}
		const hs = this.eH.step(h, 0.25);
		const sp = this.eS.step(clamp01(v[11] * 8 / 6), 0.25);
		return {
			gauge: clamp01(hs / 3),
			ruler: sp,
			value: hs.toFixed(2),
			chip: 'BIT',
			params: PRESETS[this.pr].label,
			rulerEnds: ['−', '+']
		};
	}

	/** Til testar: gjennomsnittsflyten i eit utsnitt (arbeidspiksel, origo nede til venstre). */
	debug(ctx: Ctx, arg?: unknown): unknown {
		const a = arg as { x: number; y: number; w: number; h: number } | undefined;
		const g = ctx.gfx;
		const gl = g.gl;
		const r = a ?? { x: 0, y: 0, w: ctx.w, h: ctx.h };
		const buf = new Float32Array(r.w * r.h * 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.flow.fbo);
		gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.FLOAT, buf);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		let sx = 0;
		let sy = 0;
		for (let i = 0; i < r.w * r.h; i++) {
			sx += buf[i * 4];
			sy += buf[i * 4 + 1];
		}
		const n = r.w * r.h;
		return { fx: sx / n, fy: sy / n, hist: this.red.v.slice(0, 12), count: this.red.count };
	}

	dispose() {
		this.lum.forEach((t) => t.del());
		this.G.forEach((p) => p.forEach((t) => t.del()));
		this.D.forEach((t) => t.del());
		this.zero?.del();
		this.flow?.del();
		this.ink.forEach((t) => t.del());
		this.maps.forEach((t) => t.del());
		this.red?.dispose();
	}
}
