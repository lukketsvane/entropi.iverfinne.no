import type { Gfx, Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, RAMPS, clamp01 } from './common';

/**
 * Tidspil. Ser tida ut til å gå éi veg i denne flekken?
 *
 * Eit prosessbilete er reversibelt viss ei filmrull køyrd baklengs kunne vore ein like truleg film.
 * Kvar piksel gir ei tidsrekkje x(t). Endringa d = x(t) − x(t−1) skifter forteikn når tida snur.
 * Er fordelinga av d symmetrisk, er det ingen pil. Den enklaste vitnet om ei pil er det tredje momentet:
 * γ = E[d³] / E[d²]^1.5 (Schreiber og Schmitz sin tidsasymmetri, normalisert).
 *   γ > 0: rask opp, sakte ned (eit glimt, ei flamme som tek seg opp)  → varm
 *   γ < 0: sakte opp, rask ned (ein skugge som veks, ei lampe som sloknar brått) → kald
 * E[d²] og E[d³] vert haldne som glidande snitt per piksel (vindauge W bilete), og så slått saman
 * over P×P piksel med mipmap. Det er to grovkorningar: tid og rom. Trykk på parametrane for å bla.
 *
 * Eining: for ein liten γ er KL-avstanden mellom fordelinga av d og den speglte ≈ γ²/3 nat (Edgeworth).
 * Vi viser bit = log2(1 + (γ² − 6/n)/3), der 6/n er forventa γ² av ren støy med n effektive prøver.
 * Det gir null for støy og stille scener. Det er ikkje entropiproduksjon: det er éin test av éin sak,
 * og symmetriske hendingar (ein tynn stav som passerer) kansellerer innan vindauget. Eit lengre vindauge
 * kanselerer meir. Det er ikkje ein feil, det er grovkorninga.
 */
const SCALE = 16; // gråtrinn per eining i tilstanden, så d³ ikkje går over F16-taket
const BMAX = 4; // kartet lagrar bit/4
const V0_GRAY = 1.2; // under dette (rms av d, gråtrinn) er pila udefinert
const GAUGE_FS = 0.6; // snitt-bit som fyller batteriet

interface Preset {
	/** glidande vindauge, bilete */
	win: number;
	/** mipmap-nivå for romleg samanslåing: 2^lod × 2^lod piksel */
	lod: number;
	note: string;
}
const PRESETS: Preset[] = [
	{ win: 30, lod: 2, note: 'Minne 30 bilete, 4×4 piksel.' },
	{ win: 8, lod: 2, note: 'Minne 8 bilete. Kvar kant tel.' },
	{ win: 120, lod: 2, note: 'Minne 120 bilete. Symmetriske rørsler kansellerer.' },
	{ win: 30, lod: 4, note: '16×16 piksel. Grovare i rommet.' }
];

const FS_UPDATE = `
uniform sampler2D uFrame;
uniform sampler2D uPrevF;
uniform sampler2D uAcc;
uniform float uA;
uniform float uLive;
void main() {
	float x = texture(uFrame, vUv).a * 255.0;
	float xp = texture(uPrevF, vUv).a * 255.0;
	float d = (x - xp) / ${SCALE}.0;
	vec2 s = texture(uAcc, vUv).rg;
	s = mix(s, vec2(d * d, d * d * d), uA * uLive);
	o = vec4(s, 0.0, 1.0);
}`;

const FS_COPY = `
uniform sampler2D uAcc;
void main() { o = vec4(texture(uAcc, vUv).rg, 0.0, 1.0); }`;

const FS_EST = `
uniform sampler2D uPool;
uniform float uLod;
uniform float uWarm;
uniform float uNeff;
uniform float uNpool;
uniform float uV0;
void main() {
	vec2 m = textureLod(uPool, vUv, uLod).rg / max(uWarm, 1e-4);
	float v = max(m.x, 1e-6);
	float g = m.y / (v * sqrt(v));
	float nt = max(uNeff * uNpool, 1.0);
	float z = abs(g) / sqrt(6.0 / nt);
	float sig = smoothstep(3.0, 6.0, z) * step(uV0, m.x);
	float bits = sig * log2(1.0 + max(0.0, g * g - 6.0 / nt) / 3.0);
	float sgn = sig * clamp(g / 4.0, -1.0, 1.0);
	o = vec4(min(bits / ${BMAX}.0, 1.0), 0.5 + 0.5 * sgn, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}${RAMPS}
uniform sampler2D uMap;
void main() {
	vec2 m = texture(uMap, vUv).rg;
	float L = dot(camera(vUv), vec3(0.2126, 0.7152, 0.0722));
	float v = smoothstep(0.04, 0.6, m.x);
	float s = (m.y - 0.5) * 2.0;
	vec3 hot = mix(rampCool(v), rampWarm(v), smoothstep(-0.12, 0.12, s));
	vec3 col = vec3(L) * 0.13 * (1.0 - v) + hot;
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Pil implements Setup {
	readonly info: SetupInfo = {
		id: 'pil',
		code: 'PIL',
		group: 'tid',
		name: 'Tidspil',
		blurb: 'Der tida går éi veg. Varmt: brått opp, sakte ned. Kaldt: omvendt.',
		how: 'Gjer ei rørsle. Varmt er brått opp og sakte ned, kaldt er omvendt. Trykk på talet nede til høgre for anna tidsvindauge.',
		needsFloat: true,
		probe: true,
		still: true
	};

	private uProg!: Prog;
	private cProg!: Prog;
	private eProg!: Prog;
	private dProg!: Prog;
	private acc: Target[] = [];
	private ai = 0;
	private pool!: Target;
	private map!: Target;
	private meter!: MapMeter;
	private pi = 0;
	/** oppdateringar sidan tilstanden vart nullstilt */
	private k = 0;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.uProg = g.prog('pil.update', FS_UPDATE);
		this.cProg = g.prog('pil.copy', FS_COPY);
		this.eProg = g.prog('pil.est', FS_EST);
		this.dProg = g.prog('pil.draw', FS_DRAW);
		// akkumulatorane treng presisjon (glidande snitt av små tal): F32 viss mogleg, ellers F16
		const af = g.floatFmt();
		this.acc = [g.target(ctx.w, ctx.h, af, false, false), g.target(ctx.w, ctx.h, af, false, false)];
		this.pool = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.reset(g);
	}

	private get pre() {
		return PRESETS[this.pi];
	}

	private reset(g: Gfx) {
		const gl = g.gl;
		for (const t of this.acc) {
			g.to(t);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
		this.k = 0;
	}

	cycle(ctx: Ctx): string {
		const before = this.pre.win;
		this.pi = (this.pi + 1) % PRESETS.length;
		if (this.pre.win !== before) this.reset(ctx.gfx);
		this.eG.reset();
		this.eS.reset();
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { win, lod } = this.pre;
		const a = 1 / win;
		const live = ctx.frameNo >= 2;
		if (live) this.k++;

		// 1. glidande snitt av d² og d³ per piksel
		const out = this.acc[this.ai];
		const prev = this.acc[1 - this.ai];
		g.to(out);
		g.use(this.uProg);
		g.sampler(this.uProg, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.uProg, 'uPrevF', 1, ctx.prev.tex);
		g.sampler(this.uProg, 'uAcc', 2, prev.tex);
		gl.uniform1f(this.uProg.u('uA'), a);
		gl.uniform1f(this.uProg.u('uLive'), live ? 1 : 0);
		g.quad();
		this.ai ^= 1;

		// 2. kopi til F16 med mipmap, for samanslåing over P×P piksel
		g.to(this.pool);
		g.use(this.cProg);
		g.sampler(this.cProg, 'uAcc', 0, out.tex);
		g.quad();
		g.mipmap(this.pool);

		// 3. γ og bit per piksel, null der støy eller stilleheit
		const bk = Math.pow(1 - a, this.k);
		const warm = 1 - bk;
		const neff = ((2 - a) / a) * ((1 - bk) / (1 + bk));
		const v0 = (V0_GRAY / SCALE) ** 2;
		g.to(this.map);
		g.use(this.eProg);
		g.sampler(this.eProg, 'uPool', 0, this.pool.tex);
		gl.uniform1f(this.eProg.u('uLod'), lod);
		gl.uniform1f(this.eProg.u('uWarm'), warm);
		gl.uniform1f(this.eProg.u('uNeff'), neff);
		gl.uniform1f(this.eProg.u('uNpool'), 4 ** lod);
		gl.uniform1f(this.eProg.u('uV0'), v0);
		g.quad();

		// 4. målarar: A = bit, B = forteikn (0.5 = ingen pil)
		this.meter.run(ctx, this.map, 0, 1);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dProg);
		g.sampler(this.dProg, 'uMap', 0, this.map.tex);
		g.sampler(this.dProg, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dProg.u('uCover'), ctx.cover[0], ctx.cover[1]);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const gm = this.eG.step(m.globalA * BMAX, 0.3);
		const sp = this.eS.step(m.spotB, 0.3);
		const { win, lod } = this.pre;
		return {
			gauge: clamp01(gm / GAUGE_FS),
			ruler: clamp01(sp),
			value: gm.toFixed(2),
			chip: 'BIT',
			params: `W${win} P${2 ** lod}`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.acc.forEach((t) => t.del());
		this.pool?.del();
		this.map?.del();
		this.meter?.dispose();
	}
}
