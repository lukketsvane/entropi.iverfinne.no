import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { Ease, MapMeter, clamp01 } from './common';

/**
 * Spinn. Eit fotografi teikna av små magnetar.
 *
 * Kvar piksel er ein spinn som står i ein av q tilstandar (q = 2 er Ising-modellen, q > 2 er Potts-modellen).
 * Naboar som peikar same veg senkar energien, E = −J·Σ δ(sᵢ, sⱼ). Spinnen vert flytta etter Metropolis-regelen:
 * eit forslag vert godteke med sannsyn min(1, e^(−ΔE/T)). Så Boltzmanns fordeling, rekna ut piksel for piksel
 * på GPU-en, med sjakkbrettoppdatering (like og odde ruter vekselvis, så kvar rute berre ser ferdige naboar).
 *
 * Temperaturen kjem frå kameraet. Mørkt er kaldt, lyst er varmt, og gråtonen i midten er kritisk temperatur,
 * T_c = 1/ln(1 + √q) (Onsager for Ising: 2.269 J i ein anna konvensjon). Kaldt: spinnane rettar seg og
 * flekkane veks, med korte kantar (krumningsdriven grovkorning). Varmt: ren støy. Ved T_c finst det flekkar på
 * alle skalaer, og det er der den store entropien ligg i strukturen. Eit fotografi vert til eit kart over fase:
 * fast, kritisk, smelta.
 *
 * Talet er Boltzmann-entropien per spinn i ei 4×4-rute, S = log2(16!/Πnₖ!)/16: kor mange måtar ruta kan stokkast
 * på utan at telling per tilstand endrar seg. Ein ordna flekk gir 0, støy gir ca. 0.85 bit (q = 2). Som i Katten
 * er det grovkorninga (4×4) som avgjer kva entropi er.
 *
 * Linjalen viser temperaturen under sonden, med kritisk temperatur i midten.
 *
 * Trykk: kvelv. Alt vert slumpa på nytt, som å kasta ein varm metallbit i kaldt vatn, og ein ser strukturen
 * vekse fram att. Hald fingeren nede: han er ein varm tupp som smeltar bildet under seg.
 */
const SWEEPS = 4;

interface Preset {
	label: string;
	note: string;
	q: number;
	/** 0 = spinn for spinn, 1 = snitt over 4×4 (det eit auge ser) */
	view: 0 | 1;
	/** temperatur = T_c · (lo + span · lys) */
	lo: number;
	span: number;
	/** størst mogleg blokkentropi per spinn, til batteriet */
	smax: number;
}

const PRESETS: Preset[] = [
	{
		label: 'ISING',
		note: 'Ising. Kvar piksel er ein magnet, opp eller ned. Lyset er varme: mørkt fryser til flekkar, lyst vert støy.',
		q: 2,
		view: 0,
		lo: 0.45,
		span: 1.1,
		smax: 0.853
	},
	{
		label: 'POTTS 3',
		note: 'Tre tilstandar. Same lov, tre fargar. Grensene mellom flekkane vert glatte over tid.',
		q: 3,
		view: 0,
		lo: 0.45,
		span: 1.1,
		smax: 1.31
	},
	{
		label: 'POTTS 5',
		note: 'Fem tilstandar. Meir uorden å velje blant, så støyen er rikare.',
		q: 5,
		view: 0,
		lo: 0.45,
		span: 1.1,
		smax: 1.83
	},
	{
		label: 'GROV',
		note: 'Same Ising, men snitt over 4×4 piksel: det eit auge ser. Støy vert grått, flekkar held fargen.',
		q: 2,
		view: 1,
		lo: 0.45,
		span: 1.1,
		smax: 0.853
	}
];

const HASH = `
uint pcg(uint v) {
	uint s = v * 747796405u + 2891336453u;
	uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
	return (w >> 22u) ^ w;
}
uint hash3(uvec3 p) {
	return pcg(p.x + pcg(p.y + pcg(p.z)));
}`;

const FS_INIT = `${HASH}
uniform int uQ;
uniform uint uSeed;
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	uint h = hash3(uvec3(uint(p.x), uint(p.y), uSeed));
	o = vec4(float(int(h % uint(uQ))) / 255.0, 0.0, 0.0, 1.0);
}`;

const FS_UPD = `${HASH}
uniform sampler2D uS;
uniform sampler2D uCam;
uniform ivec2 uSize;
uniform int uQ;
uniform int uPar;
uniform uint uSeed;
uniform float uTc;
uniform float uLo;
uniform float uSpan;
uniform vec4 uHeat;
uniform float uAsp;
int st(ivec2 p) {
	p = ivec2((p.x + uSize.x) % uSize.x, (p.y + uSize.y) % uSize.y);
	return int(texelFetch(uS, p, 0).r * 255.0 + 0.5);
}
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	int s = st(p);
	if (((p.x + p.y) & 1) != uPar) {
		o = vec4(float(s) / 255.0, 0.0, 0.0, 1.0);
		return;
	}
	int a = st(p + ivec2(1, 0));
	int b = st(p - ivec2(1, 0));
	int c = st(p + ivec2(0, 1));
	int d = st(p - ivec2(0, 1));
	uint h = hash3(uvec3(uint(p.x), uint(p.y), uSeed));
	int sp = (s + 1 + int(h % uint(uQ - 1))) % uQ;
	float eOld = float((a == s ? 1 : 0) + (b == s ? 1 : 0) + (c == s ? 1 : 0) + (d == s ? 1 : 0));
	float eNew = float((a == sp ? 1 : 0) + (b == sp ? 1 : 0) + (c == sp ? 1 : 0) + (d == sp ? 1 : 0));
	float dE = eOld - eNew;
	vec2 uv = (vec2(p) + 0.5) / vec2(uSize);
	float L = texture(uCam, uv).a;
	vec2 dh = (uv - uHeat.xy) * vec2(uAsp, 1.0);
	float T = uTc * (uLo + uSpan * L + uHeat.z * exp(-dot(dh, dh) / 0.0035));
	float r = float(pcg(h ^ 0x9e3779b9u) >> 8) / 16777216.0;
	if (dE <= 0.0 || r < exp(-dE / T)) s = sp;
	o = vec4(float(s) / 255.0, 0.0, 0.0, 1.0);
}`;

const PAL = `
const vec3 PAL[5] = vec3[5](
	vec3(0.035, 0.035, 0.05),
	vec3(0.93, 0.91, 0.85),
	vec3(0.88, 0.24, 0.11),
	vec3(0.10, 0.22, 0.64),
	vec3(0.92, 0.70, 0.16)
);`;

const FS_PAINT = `${PAL}
uniform sampler2D uS;
uniform sampler2D uCam;
void main() {
	int s = int(texelFetch(uS, ivec2(gl_FragCoord.xy), 0).r * 255.0 + 0.5);
	float L = texture(uCam, vUv).a;
	o = vec4(mix(PAL[s] * (0.5 + 0.8 * L), vec3(L), 0.14), 1.0);
}`;

const FS_MAP = `
uniform sampler2D uS;
uniform sampler2D uCam;
uniform int uQ;
uniform float uLo;
uniform float uSpan;
float lf(float n) {
	if (n < 2.0) return 0.0;
	return (n * log(n) - n + 0.5 * log(6.2831853 * n) + 1.0 / (12.0 * n)) * 1.4426950;
}
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	ivec2 b = (p >> 2) << 2;
	float cnt[5];
	for (int k = 0; k < 5; k++) cnt[k] = 0.0;
	for (int j = 0; j < 4; j++) {
		for (int i = 0; i < 4; i++) {
			int s = int(texelFetch(uS, b + ivec2(i, j), 0).r * 255.0 + 0.5);
			cnt[s] += 1.0;
		}
	}
	float sum = 0.0;
	for (int k = 0; k < 5; k++) sum += lf(cnt[k]);
	float S = (lf(16.0) - sum) / 16.0;
	float L = texture(uCam, vUv).a;
	o = vec4(S / 2.0, (uLo + uSpan * L) / 2.0, 0.0, 1.0);
}`;

const FS_DRAW = `${PAL}
uniform sampler2D uImg;
uniform ivec2 uSize;
uniform int uMode;
void main() {
	vec3 col;
	if (uMode == 0) col = texelFetch(uImg, clamp(ivec2(vUv * vec2(uSize)), ivec2(0), uSize - 1), 0).rgb;
	else col = textureLod(uImg, vUv, 2.0).rgb;
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

/** Kritisk temperatur for q-tilstands Potts-modell på eit kvadratgitter (J = 1). */
const tc = (q: number) => 1 / Math.log(1 + Math.sqrt(q));

export class Spinn implements Setup {
	readonly info: SetupInfo = {
		id: 'spinn',
		code: 'SPI',
		group: 'dyn',
		name: 'Spinn',
		blurb: 'Kvar piksel er ein liten magnet. Lys er varme: mørkt fryser til flekkar, lyst vert støy.',
		how: 'Trykk: kvelv alt, og sjå strukturen vekse fram. Hald fingeren nede: ein varm tupp som smeltar.',
		needsFloat: true,
		probe: true,
		press: true
	};

	private iP!: Prog;
	private uP!: Prog;
	private pP!: Prog;
	private mP!: Prog;
	private dP!: Prog;
	private s: Target[] = [];
	private si = 0;
	private img!: Target;
	private map!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private seed = 1;
	private reseed = true;
	private heat = 0;
	private heatTarget = 0;
	private hx = 0.5;
	private hy = 0.5;
	private eS = new Ease();
	private eT = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.iP = g.prog('spi.init', FS_INIT);
		this.uP = g.prog('spi.upd', FS_UPD);
		this.pP = g.prog('spi.paint', FS_PAINT);
		this.mP = g.prog('spi.map', FS_MAP);
		this.dP = g.prog('spi.draw', FS_DRAW);
		this.s = [g.target(ctx.w, ctx.h, g.U8, false), g.target(ctx.w, ctx.h, g.U8, false)];
		this.img = g.target(ctx.w, ctx.h, g.U8, true, true);
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.reseed = true;
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	tap(): boolean {
		this.reseed = true;
		return true;
	}

	touch(_ctx: Ctx, x: number, y: number, down: boolean) {
		this.heatTarget = down ? 1 : 0;
		if (down) {
			this.hx = x;
			this.hy = y;
		}
	}

	cycle(): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.reseed = true;
		this.eS.reset();
		this.eT.reset();
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const p = this.pre;

		if (this.reseed) {
			this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
			g.to(this.s[this.si]);
			g.use(this.iP);
			gl.uniform1i(this.iP.u('uQ'), p.q);
			gl.uniform1ui(this.iP.u('uSeed'), this.seed);
			g.quad();
			this.reseed = false;
		}

		this.heat += (this.heatTarget * 2.2 - this.heat) * 0.25;

		for (let k = 0; k < SWEEPS * 2; k++) {
			this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
			g.to(this.s[1 - this.si]);
			g.use(this.uP);
			g.sampler(this.uP, 'uS', 0, this.s[this.si].tex);
			g.sampler(this.uP, 'uCam', 1, ctx.cur.tex);
			gl.uniform2i(this.uP.u('uSize'), ctx.w, ctx.h);
			gl.uniform1i(this.uP.u('uQ'), p.q);
			gl.uniform1i(this.uP.u('uPar'), k & 1);
			gl.uniform1ui(this.uP.u('uSeed'), this.seed);
			gl.uniform1f(this.uP.u('uTc'), tc(p.q));
			gl.uniform1f(this.uP.u('uLo'), p.lo);
			gl.uniform1f(this.uP.u('uSpan'), p.span);
			gl.uniform4f(this.uP.u('uHeat'), this.hx, this.hy, this.heat, 0);
			gl.uniform1f(this.uP.u('uAsp'), ctx.w / ctx.h);
			g.quad();
			this.si ^= 1;
		}

		g.to(this.img);
		g.use(this.pP);
		g.sampler(this.pP, 'uS', 0, this.s[this.si].tex);
		g.sampler(this.pP, 'uCam', 1, ctx.cur.tex);
		g.quad();
		g.mipmap(this.img);

		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uS', 0, this.s[this.si].tex);
		g.sampler(this.mP, 'uCam', 1, ctx.cur.tex);
		gl.uniform1i(this.mP.u('uQ'), p.q);
		gl.uniform1f(this.mP.u('uLo'), p.lo);
		gl.uniform1f(this.mP.u('uSpan'), p.span);
		g.quad();
		this.meter.run(ctx, this.map, 0, 1);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uImg', 0, this.img.tex);
		gl.uniform2i(this.dP.u('uSize'), ctx.w, ctx.h);
		gl.uniform1i(this.dP.u('uMode'), this.pre.view);
		g.quad();
	}

	meters(): Meters {
		const p = this.pre;
		const S = this.eS.step(this.meter.globalA * 2, 0.3);
		const Tr = this.eT.step(this.meter.spotB * 2, 0.3);
		return {
			gauge: clamp01(S / p.smax),
			ruler: clamp01(Tr / 2),
			value: S.toFixed(2),
			chip: 'BIT',
			params: p.label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.s.forEach((t) => t.del());
		this.img?.del();
		this.map?.del();
		this.meter?.dispose();
	}
}
