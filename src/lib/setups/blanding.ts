import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { Ease, clamp01 } from './common';

/**
 * Blanding. Boltzmanns poeng utan å jukse.
 * Eit trykk fryser biletet og byrjar å byte piksel parvis. Reglane er reversible og deterministiske:
 * kvart steg er ein involusjon (to piksel byter plass, eller ikkje): spegling om eit tilfeldig punkt langs ei rad eller kolonne,
 * vald av ein hash av stegnummeret.
 * Ingen piksel vert endra, berre flytta. Dermed ligg histogrammet fast, og 1-piksel-entropien H er konstant.
 * Det som forsvinn er rekkjefølgja: den gjensidige informasjonen I mellom nabopiksel fell mot null.
 * Biletet ser ut til å bli «uordna» sjølv om ingenting er tapt. Eit nytt trykk køyrer same reglane baklengs,
 * og biletet kjem tilbake piksel for piksel. Tidspilen er grovkorninga, ikkje fysikken.
 * Ingenting vert lagra utanom stegnummeret.
 */
const P = 0.02; // sjanse per piksel og steg for å bli flytta
const T_MAX = 150; // steg (≈ 5 s ved 30 bilete/s)

const FS_COPY = `
uniform sampler2D uSrc;
void main() { o = texture(uSrc, vUv); }`;

const FS_STEP = `
uniform sampler2D uS;
uniform ivec2 uSize;
uniform int uT;
uniform float uP;

uint pcg(uint v) {
	uint st = v * 747796405u + 2891336453u;
	uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u;
	return (w >> 22u) ^ w;
}

void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	uint t = uint(uT);
	uint h = pcg(t * 2654435761u + 12345u);
	bool horiz = (h & 1u) == 0u;
	// partner = spegling om eit tilfeldig punkt: (K - x) mod N er alltid ein involusjon, utan kantskeivskap
	ivec2 q;
	if (horiz) {
		int K = int((h >> 1) % uint(uSize.x));
		q = ivec2((K + uSize.x - c.x) % uSize.x, c.y);
	} else {
		int K = int((h >> 1) % uint(uSize.y));
		q = ivec2(c.x, (K + uSize.y - c.y) % uSize.y);
	}
	ivec2 m = min(c, q);
	uint ph = pcg(uint(m.x) * 73856093u ^ uint(m.y) * 19349663u ^ pcg(t + 977u));
	float r = float(ph & 0xFFFFFFu) / 16777216.0;
	ivec2 src = (r < uP && q != c) ? q : c;
	o = texelFetch(uS, src, 0);
}`;

const FS_DRAW = `
uniform sampler2D uS;
void main() {
	vec3 c = texture(uS, vUv).rgb;
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	c *= 1.0 - 0.38 * top - 0.45 * bot;
	o = vec4(c, 1.0);
}`;

type Mode = 'live' | 'mix';

export class Blanding implements Setup {
	readonly info: SetupInfo = {
		id: 'blanding',
		code: 'BLA',
		name: 'Blanding',
		blurb: 'Same piksel, tapt rekkjefølgje. Trykk: snu tida.',
		needsFloat: false,
		probe: false
	};

	private copy!: Prog;
	private step!: Prog;
	private draw_!: Prog;
	private S: Target[] = [];
	private si = 0;
	private mode: Mode = 'live';
	private t = 0;
	private dir = 0; // +1 framover, −1 bakover, 0 ro
	private H = 0;
	private I = 0;
	private last = -1e9;
	private eI = new Ease();
	private eH = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.copy = g.prog('bla.copy', FS_COPY);
		this.step = g.prog('bla.step', FS_STEP);
		this.draw_ = g.prog('bla.draw', FS_DRAW);
		this.S = [g.target(ctx.w, ctx.h, g.U8, false), g.target(ctx.w, ctx.h, g.U8, false)];
	}

	tap(_ctx: Ctx): boolean {
		if (this.mode === 'live') {
			this.mode = 'mix';
			this.dir = 1;
			this.t = 0;
		} else if (this.dir > 0 || this.dir === 0) {
			this.dir = -1;
		} else {
			this.dir = 1;
		}
		return true;
	}

	/** Éitt steg i éin retning: S[si] → S[1-si]. t er stegnummeret som styrer hashen. */
	private advance(ctx: Ctx, stepIndex: number) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.to(this.S[1 - this.si]);
		g.use(this.step);
		g.sampler(this.step, 'uS', 0, this.S[this.si].tex);
		gl.uniform2i(this.step.u('uSize'), ctx.w, ctx.h);
		gl.uniform1i(this.step.u('uT'), stepIndex);
		gl.uniform1f(this.step.u('uP'), P);
		g.quad();
		this.si ^= 1;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		if (this.mode === 'live') {
			g.to(this.S[this.si]);
			g.use(this.copy);
			g.sampler(this.copy, 'uSrc', 0, ctx.cur.tex);
			g.quad();
		} else if (this.dir > 0) {
			if (this.t < T_MAX) {
				this.advance(ctx, this.t);
				this.t++;
			}
			if (this.t >= T_MAX) this.dir = 0;
		} else if (this.dir < 0) {
			if (this.t > 0) {
				this.advance(ctx, this.t - 1);
				this.t--;
			}
			if (this.t <= 0) {
				this.t = 0;
				this.dir = 0;
				this.mode = 'live';
			}
		}

		if (ctx.now - this.last >= 160) {
			const w = ctx.w;
			const h = ctx.h;
			const ok = ctx.read(this.S[this.si], 0, 0, w, h, (b) => this.analyse(b, w, h));
			if (ok) this.last = ctx.now;
		}
	}

	/** H = entropien til 16 lysnivå per piksel. I = gjensidig informasjon mellom nabopiksel (vassrett + loddrett). */
	private analyse(b: Uint8Array, w: number, h: number) {
		const K = 16;
		const q = new Uint8Array(w * h);
		const one = new Uint32Array(K);
		for (let i = 0; i < w * h; i++) {
			const v = b[i * 4 + 3] >> 4;
			q[i] = v;
			one[v]++;
		}
		const joint = new Uint32Array(K * K);
		let pairs = 0;
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) {
				const a = q[row + x];
				if (x + 1 < w) {
					joint[a * K + q[row + x + 1]]++;
					pairs++;
				}
				if (y + 1 < h) {
					joint[a * K + q[row + w + x]]++;
					pairs++;
				}
			}
		}
		let H = 0;
		const n = w * h;
		for (let k = 0; k < K; k++) {
			if (one[k]) {
				const p = one[k] / n;
				H -= p * Math.log2(p);
			}
		}
		const pa = new Float64Array(K);
		const pb = new Float64Array(K);
		for (let a = 0; a < K; a++) {
			for (let c = 0; c < K; c++) {
				const p = joint[a * K + c] / pairs;
				pa[a] += p;
				pb[c] += p;
			}
		}
		let I = 0;
		for (let a = 0; a < K; a++) {
			for (let c = 0; c < K; c++) {
				const j = joint[a * K + c];
				if (j) {
					const p = j / pairs;
					I += p * Math.log2(p / (pa[a] * pb[c]));
				}
			}
		}
		this.H = H;
		this.I = Math.max(0, I);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		g.use(this.draw_);
		g.sampler(this.draw_, 'uS', 0, this.S[this.si].tex);
		g.quad();
	}

	meters(): Meters {
		const H = this.eH.step(this.H, 0.3);
		const I = this.eI.step(this.I, 0.3);
		return {
			gauge: clamp01(H > 0 ? I / H : 0),
			ruler: clamp01(this.t / T_MAX),
			value: I.toFixed(2),
			chip: 'I',
			params: `H${H.toFixed(2)}`,
			rulerEnds: ['−', '+']
		};
	}

	/** Til testar: stegnummer og retning. */
	get state() {
		return { mode: this.mode, t: this.t, dir: this.dir, si: this.si, H: this.H, I: this.I };
	}

	dispose() {
		this.S.forEach((t) => t.del());
	}
}
