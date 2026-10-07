import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Demon. Kva er det same biletet utan rekkjefølgja?
 *
 * Ein demon sorterer pikslane etter lys, ei rad (eller kolonne) om gongen, ved at naboar byter plass viss dei
 * står feil veg (odd-even transposition sort). Tilstanden er ein permutasjon som vert halden ved like, så
 * demonen jagar det levande biletet. Ingen piksel vert endra, berre flytta.
 *
 * Cella er grovkorninga: pikslane kan berre byte plass innanfor ei celle på R piksel. Det som er att i cella
 * er histogrammet, makrotilstanden: kor mange piksel som er mørke, grå og lyse, men ikkje kvar. Talet på måtar
 * cella kunne vore stokka på og sjå lik ut er W = N! / Πn_k! (n_k = piksel i lysnivå k), og Boltzmann sin
 * S = log2(W) / N er det som vert vist, i bit per piksel. Det er rekkjefølgja demonen kastar.
 * Eksakt multinomial, ikkje Shannon-grensa: for små celler er S godt under H, fordi N! veks seinare enn N·log N.
 *
 * Linjalen er orden: 1 − 2·(delen naboar som står feil veg). Tilfeldig (ikkje-heilt-lik) rekkjefølgje gir 0, sortert gir 1.
 */
const BINS_MAX = 64;
const SMAX = 8; // kartet lagrar S/8

interface Preset {
	axis: 0 | 1;
	/** celle, piksel i arbeidsbiletet. 0 = heile rada */
	cell: number;
	bins: number;
	/** steg per bilete: kor fort demonen jobbar */
	pass: number;
	note: string;
	label: string;
}

const PRESETS: Preset[] = [
	{ axis: 0, cell: 64, bins: 64, pass: 3, label: 'RAD 64P', note: 'Celler på 64 piksel i kvar rad. Demonen sorterer innanfor cella.' },
	{ axis: 0, cell: 0, bins: 64, pass: 4, label: 'RAD HEIL', note: 'Heile rada er éi celle. Berre fordelinga av lys er att.' },
	{ axis: 0, cell: 16, bins: 64, pass: 3, label: 'RAD 16P', note: 'Celler på 16 piksel. Små celler kastar lite rekkjefølgje.' },
	{ axis: 1, cell: 64, bins: 64, pass: 3, label: 'KOL 64P', note: 'Same demon, men nedover i kolonnene.' },
	{ axis: 0, cell: 64, bins: 4, pass: 3, label: 'RAD 4B', note: 'Berre 4 lysnivå. Grovare nivå gir færre måtar å stokke på.' }
];

const FS_INIT = `
uniform int uAxis;
void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	o = vec4(float(uAxis == 0 ? c.x : c.y), 0.0, 0.0, 1.0);
}`;

const KEY = `
uniform sampler2D uFrame;
uniform int uBins;
uniform int uAxis;
float keyOf(float idx, ivec2 c) {
	ivec2 p = uAxis == 0 ? ivec2(int(idx + 0.5), c.y) : ivec2(c.x, int(idx + 0.5));
	float l = texelFetch(uFrame, p, 0).a;
	return float(min(int(l * float(uBins)), uBins - 1));
}`;

const FS_STEP = `${KEY}
uniform sampler2D uPerm;
uniform ivec2 uSize;
uniform int uPar;
uniform int uCell;
void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	int pos = uAxis == 0 ? c.x : c.y;
	int n = uAxis == 0 ? uSize.x : uSize.y;
	float a = texelFetch(uPerm, c, 0).r;
	int d = ((pos - uPar) & 1) == 0 ? 1 : -1;
	int q = pos + d;
	if (q < 0 || q >= n) { o = vec4(a, 0.0, 0.0, 1.0); return; }
	if (uCell > 0 && (pos / uCell) != (q / uCell)) { o = vec4(a, 0.0, 0.0, 1.0); return; }
	ivec2 cq = uAxis == 0 ? ivec2(q, c.y) : ivec2(c.x, q);
	float b = texelFetch(uPerm, cq, 0).r;
	float ka = keyOf(a, c) * 1024.0 + a;
	float kb = keyOf(b, cq) * 1024.0 + b;
	bool sw = d == 1 ? ka > kb : kb > ka;
	o = vec4(sw ? b : a, 0.0, 0.0, 1.0);
}`;

const FS_H = `
uniform sampler2D uFrame;
uniform ivec2 uSize;
uniform int uAxis;
uniform int uCell;
uniform int uBins;
float lf(float n) {
	if (n < 2.0) return 0.0;
	return (n * log(n) - n + 0.5 * log(6.2831853 * n) + 1.0 / (12.0 * n)) * 1.4426950;
}
void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	int cellIdx = uAxis == 0 ? c.x : c.y;
	int line = uAxis == 0 ? c.y : c.x;
	int n = uAxis == 0 ? uSize.x : uSize.y;
	int cs = uCell > 0 ? uCell : n;
	int a0 = cellIdx * cs;
	int a1 = min(n, a0 + cs);
	float cnt[${BINS_MAX}];
	for (int k = 0; k < ${BINS_MAX}; k++) cnt[k] = 0.0;
	for (int i = a0; i < a1; i++) {
		float l = texelFetch(uFrame, uAxis == 0 ? ivec2(i, line) : ivec2(line, i), 0).a;
		int k = min(int(l * float(uBins)), uBins - 1);
		cnt[k] += 1.0;
	}
	float sum = 0.0;
	for (int k = 0; k < ${BINS_MAX}; k++) sum += lf(cnt[k]);
	float N = float(a1 - a0);
	float S = (lf(N) - sum) / max(N, 1.0);
	o = vec4(S / ${SMAX}.0, 0.0, 0.0, 1.0);
}`;

const FS_MAP = `${KEY}
uniform sampler2D uPerm;
uniform sampler2D uH;
uniform ivec2 uSize;
uniform int uCell;
void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	int pos = uAxis == 0 ? c.x : c.y;
	int line = uAxis == 0 ? c.y : c.x;
	int n = uAxis == 0 ? uSize.x : uSize.y;
	int cs = uCell > 0 ? uCell : n;
	int cellIdx = pos / cs;
	float s = texelFetch(uH, uAxis == 0 ? ivec2(cellIdx, line) : ivec2(line, cellIdx), 0).r;
	float desc = 0.0;
	int q = pos + 1;
	if (q < n && (q / cs) == cellIdx) {
		ivec2 cq = uAxis == 0 ? ivec2(q, c.y) : ivec2(c.x, q);
		float a = texelFetch(uPerm, c, 0).r;
		float b = texelFetch(uPerm, cq, 0).r;
		desc = keyOf(a, c) > keyOf(b, cq) ? 1.0 : 0.0;
	}
	o = vec4(s, desc, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uPerm;
uniform ivec2 uSize;
uniform int uAxis;
void main() {
	vec2 wp = vUv * vec2(uSize);
	ivec2 c = clamp(ivec2(floor(wp)), ivec2(0), uSize - 1);
	float idx = texelFetch(uPerm, c, 0).r;
	vec2 f = wp - floor(wp);
	vec2 src = uAxis == 0 ? vec2(idx + f.x, wp.y) : vec2(wp.x, idx + f.y);
	vec3 col = camera(src / vec2(uSize));
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Demon implements Setup {
	readonly info: SetupInfo = {
		id: 'demon',
		code: 'DEM',
		name: 'Demon',
		blurb: 'Ein demon sorterer pikslane etter lys. Same piksel, ingen rekkjefølgje.',
		how: 'Trykk: demonen byrjar på nytt. Trykk på talet nede til høgre: anna celle.',
		needsFloat: true,
		probe: false
	};

	private initP!: Prog;
	private stepP!: Prog;
	private hP!: Prog;
	private mapP!: Prog;
	private drawP!: Prog;
	private perm: Target[] = [];
	private pi = 0;
	private par = 0;
	private hT!: Target;
	private map!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private eS = new Ease();
	private eO = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.initP = g.prog('dem.init', FS_INIT);
		this.stepP = g.prog('dem.step', FS_STEP);
		this.hP = g.prog('dem.h', FS_H);
		this.mapP = g.prog('dem.map', FS_MAP);
		this.drawP = g.prog('dem.draw', FS_DRAW);
		this.perm = [g.target(ctx.w, ctx.h, g.F16, false), g.target(ctx.w, ctx.h, g.F16, false)];
		this.hT = g.target(ctx.w, ctx.h, g.F16, false);
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.reset(ctx);
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	private reset(ctx: Ctx) {
		const g = ctx.gfx;
		g.to(this.perm[this.pi]);
		g.use(this.initP);
		g.gl.uniform1i(this.initP.u('uAxis'), this.pre.axis);
		g.quad();
	}

	tap(ctx: Ctx): boolean {
		this.reset(ctx);
		return true;
	}

	cycle(ctx: Ctx): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.eS.reset();
		this.eO.reset();
		this.reset(ctx);
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { axis, cell, bins, pass } = this.pre;
		const n = axis === 0 ? ctx.w : ctx.h;
		const cs = cell > 0 ? cell : n;

		// 1. demonen jobbar: nokre steg per bilete, mot det levande biletet
		g.use(this.stepP);
		g.sampler(this.stepP, 'uFrame', 1, ctx.cur.tex);
		gl.uniform2i(this.stepP.u('uSize'), ctx.w, ctx.h);
		gl.uniform1i(this.stepP.u('uAxis'), axis);
		gl.uniform1i(this.stepP.u('uBins'), bins);
		gl.uniform1i(this.stepP.u('uCell'), cell);
		for (let k = 0; k < pass; k++) {
			g.to(this.perm[1 - this.pi]);
			g.sampler(this.stepP, 'uPerm', 0, this.perm[this.pi].tex);
			gl.uniform1i(this.stepP.u('uPar'), this.par);
			g.quad();
			this.pi ^= 1;
			this.par ^= 1;
		}

		// 2. Boltzmann: S = log2(W)/N per celle, frå det levande biletet
		const nc = Math.ceil(n / cs);
		g.to(this.hT);
		gl.viewport(0, 0, axis === 0 ? nc : ctx.w, axis === 0 ? ctx.h : nc);
		g.use(this.hP);
		g.sampler(this.hP, 'uFrame', 0, ctx.cur.tex);
		gl.uniform2i(this.hP.u('uSize'), ctx.w, ctx.h);
		gl.uniform1i(this.hP.u('uAxis'), axis);
		gl.uniform1i(this.hP.u('uCell'), cell);
		gl.uniform1i(this.hP.u('uBins'), bins);
		g.quad();

		// 3. kart: R = S/8, G = naboar som står feil veg
		g.to(this.map);
		g.use(this.mapP);
		g.sampler(this.mapP, 'uPerm', 0, this.perm[this.pi].tex);
		g.sampler(this.mapP, 'uH', 1, this.hT.tex);
		g.sampler(this.mapP, 'uFrame', 2, ctx.cur.tex);
		gl.uniform2i(this.mapP.u('uSize'), ctx.w, ctx.h);
		gl.uniform1i(this.mapP.u('uAxis'), axis);
		gl.uniform1i(this.mapP.u('uCell'), cell);
		gl.uniform1i(this.mapP.u('uBins'), bins);
		g.quad();
		this.meter.run(ctx, this.map, 0, 1);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.drawP);
		g.sampler(this.drawP, 'uPerm', 0, this.perm[this.pi].tex);
		g.sampler(this.drawP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.drawP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform2i(this.drawP.u('uSize'), ctx.w, ctx.h);
		gl.uniform1i(this.drawP.u('uAxis'), this.pre.axis);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const { cell, bins, label } = this.pre;
		const s = this.eS.step(m.globalA * SMAX, 0.3);
		// delen par som er med i ei celle: (R−1)/R. Tilfeldig rekkjefølgje har rundt halvparten feil veg.
		const R = cell > 0 ? cell : 296;
		const valid = (R - 1) / R;
		const order = this.eO.step(clamp01(1 - (2 * m.globalB) / valid), 0.25);
		return {
			gauge: clamp01(s / Math.log2(bins)),
			ruler: order,
			value: s.toFixed(2),
			chip: 'BIT',
			params: label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.perm.forEach((t) => t.del());
		this.hT?.del();
		this.map?.del();
		this.meter?.dispose();
	}
}
