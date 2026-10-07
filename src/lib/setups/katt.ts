import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Katten. Arnolds kattekart: blanding utan tap.
 *
 * Eit bilete vert teke og lagt på ein torus av piksel. Kvart steg flyttar kvar piksel etter den same faste regelen,
 * to skjeringar (x += y, så y += x), og regelen er ei omstokking: ingen piksel forsvinn, ingen vert laga. Biletet
 * vert strekt og brote saman til det ser ut som snø. Men regelen kan gå attende, og ei omstokking av endeleg
 * mange piksel kjem alltid heim: etter nøyaktig P steg er biletet slik det var, piksel for piksel (Poincaré-
 * attkomst). På halvvegs er over halvparten av pikslane alt på plass att, og biletet glimtar gjennom som ein skygge.
 *
 * Talet er Boltzmann-entropien til ei lita rute: for kvar 8x8-rute, log2 av talet på måtar å stokke pikslane
 * på som gir same histogram av lysstyrke, per piksel. Eit rolig bilete har låg entropi i kvar rute, snø har høg.
 * Entropien stig til toppen medan biletet vert blanda, og fell tilbake til starten ved attkomsten. Kurva er ikkje
 * eit brot på andre lov. Den går opp fordi ruta er grov, og ned fordi ingenting vart kasta.
 *
 * «Auge» viser det eit auge utan lupe ser: snittet over små ruter. Då vert biletet berre grått og kjem att.
 */
interface Preset {
	W: number;
	H: number;
	/** periode i steg: etter så mange er biletet attende */
	P: number;
	/** steg per bilete ved 30 bilete i sekundet */
	rate: number;
	/** 0 = nøyaktig, 1 = snittet over små ruter */
	view: 0 | 1;
	label: string;
	note: string;
}
const PRESETS: Preset[] = [
	{
		W: 192,
		H: 384,
		P: 96,
		rate: 1,
		view: 0,
		label: 'FIN',
		note: 'Arnolds kattekart. Kvar piksel flyttar seg etter same regel, og ingenting går tapt. Etter 96 steg er biletet attende.'
	},
	{
		W: 64,
		H: 128,
		P: 96,
		rate: 1,
		view: 0,
		label: 'GROV',
		note: 'Same regel, færre og større piksel.'
	},
	{
		W: 256,
		H: 512,
		P: 384,
		rate: 2,
		view: 0,
		label: 'SKARP',
		note: 'Meir oppløysing. Det tek 384 steg å koma heim, to per bilete.'
	},
	{
		W: 192,
		H: 384,
		P: 96,
		rate: 1,
		view: 1,
		label: 'AUGE',
		note: 'Slik ser eit auge utan lupe: snittet over små ruter. Alt vert grått, og kjem att.'
	}
];

const CELL = 8;
const BINS = 16;
const SMAX = 8;
const LIVE_MS = 1400;
const HOLD_MS = 1100;

const FS_SNAP = `${COVER_VIDEO}
uniform vec2 uWin;
void main() {
	vec2 su = (vUv - 0.5) / uWin + 0.5;
	o = vec4(camera(su), 1.0);
}`;

const FS_STEP = `
uniform sampler2D uS;
uniform ivec2 uSize;
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	int y = (p.y - p.x) % uSize.y;
	if (y < 0) y += uSize.y;
	int x = (p.x - y) % uSize.x;
	if (x < 0) x += uSize.x;
	o = texelFetch(uS, ivec2(x, y), 0);
}`;

const FS_ENT = `
uniform sampler2D uS;
float lf(float n) {
	if (n < 2.0) return 0.0;
	return (n * log(n) - n + 0.5 * log(6.2831853 * n) + 1.0 / (12.0 * n)) * 1.4426950;
}
void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	float cnt[${BINS}];
	for (int k = 0; k < ${BINS}; k++) cnt[k] = 0.0;
	for (int j = 0; j < ${CELL}; j++) {
		for (int i = 0; i < ${CELL}; i++) {
			vec3 v = texelFetch(uS, c * ${CELL} + ivec2(i, j), 0).rgb;
			float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
			cnt[min(int(l * ${BINS}.0), ${BINS - 1})] += 1.0;
		}
	}
	float sum = 0.0;
	for (int k = 0; k < ${BINS}; k++) sum += lf(cnt[k]);
	float N = float(${CELL * CELL});
	float S = (lf(N) - sum) / N;
	o = vec4(S / ${SMAX}.0, 0.0, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uS;
uniform ivec2 uSize;
uniform vec2 uWin;
uniform int uMode;
void main() {
	vec3 col;
	if (uMode == 0) {
		col = camera(vUv);
	} else {
		vec2 u = (vUv - 0.5) * uWin + 0.5;
		if (uMode == 1) col = texelFetch(uS, clamp(ivec2(u * vec2(uSize)), ivec2(0), uSize - 1), 0).rgb;
		else col = textureLod(uS, u, 3.0).rgb;
	}
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

type Phase = 'live' | 'run' | 'hold';

export class Katt implements Setup {
	readonly info: SetupInfo = {
		id: 'katt',
		code: 'KAT',
		group: 'dyn',
		name: 'Katten',
		blurb: 'Eit bilete vert blanda til snø etter ei fast regel, og kjem tilbake som det var.',
		how: 'Vent litt, eller trykk for å ta eit nytt bilete. Trykk på talet nede til høgre for anna oppløysing.',
		needsFloat: false,
		probe: false
	};

	private sP!: Prog;
	private tP!: Prog;
	private eP!: Prog;
	private dP!: Prog;
	private gfx!: Ctx['gfx'];
	private s: Target[] = [];
	private cur = 0;
	private ent!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private phase: Phase = 'live';
	private t = 0;
	private last = -1;
	private k = 0;
	private acc = 0;
	private eS = new Ease();

	init(ctx: Ctx) {
		this.sP = ctx.gfx.prog('kat.snap', FS_SNAP);
		this.tP = ctx.gfx.prog('kat.step', FS_STEP);
		this.eP = ctx.gfx.prog('kat.ent', FS_ENT);
		this.dP = ctx.gfx.prog('kat.draw', FS_DRAW);
		this.gfx = ctx.gfx;
		this.alloc();
		this.restart();
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	private alloc() {
		const g = this.gfx;
		const { W, H, view } = this.pre;
		this.free();
		const mips = view === 1;
		this.s = [g.target(W, H, g.U8, mips, mips), g.target(W, H, g.U8, mips, mips)];
		this.ent = g.target(W / CELL, H / CELL, g.F16, true, true);
		this.meter = new MapMeter(g, 2);
		this.cur = 0;
	}

	private free() {
		this.s.forEach((t) => t.del());
		this.s = [];
		this.ent?.del();
		this.meter?.dispose();
	}

	private restart() {
		this.phase = 'live';
		this.t = 0;
		this.k = 0;
		this.acc = 0;
		this.last = -1;
		this.eS.reset();
	}

	/** Visningsvindauget i tilstandsrommet: tilstanden dekkjer skjermen (cover). */
	private win(ctx: Ctx): [number, number] {
		const { W, H } = this.pre;
		const asp = ctx.sw / ctx.sh;
		const st = W / H;
		return st > asp ? [asp / st, 1] : [1, st / asp];
	}

	private snap(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const w = this.win(ctx);
		g.to(this.s[this.cur]);
		g.use(this.sP);
		g.sampler(this.sP, 'uVideo', 0, ctx.video);
		gl.uniform2f(this.sP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform2f(this.sP.u('uWin'), w[0], w[1]);
		g.quad();
		if (this.pre.view === 1) g.mipmap(this.s[this.cur]);
		this.k = 0;
		this.acc = 0;
		this.phase = 'run';
	}

	tap(ctx: Ctx): boolean {
		this.snap(ctx);
		return true;
	}

	cycle(ctx: Ctx): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.alloc();
		this.restart();
		void ctx;
		return this.pre.note;
	}

	private step(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { W, H, view } = this.pre;
		const src = this.s[this.cur];
		const dst = this.s[1 - this.cur];
		g.to(dst);
		g.use(this.tP);
		g.sampler(this.tP, 'uS', 0, src.tex);
		gl.uniform2i(this.tP.u('uSize'), W, H);
		g.quad();
		this.cur ^= 1;
		this.k++;
		if (view === 1) g.mipmap(this.s[this.cur]);
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const dt = this.last < 0 ? 1 / 30 : Math.min(0.12, Math.max(0.004, (ctx.now - this.last) / 1000));
		this.last = ctx.now;
		const { P, rate } = this.pre;

		if (this.phase === 'live') {
			this.t += dt * 1000;
			if (this.t >= LIVE_MS) this.snap(ctx);
		} else if (this.phase === 'run') {
			this.acc += dt * 30 * rate;
			let n = Math.min(4 * rate, Math.floor(this.acc));
			this.acc -= Math.floor(this.acc);
			while (n-- > 0 && this.k < P) this.step(ctx);
			if (this.k >= P) {
				this.phase = 'hold';
				this.t = 0;
			}
		} else {
			this.t += dt * 1000;
			if (this.t >= HOLD_MS) {
				this.phase = 'live';
				this.t = 0;
			}
		}

		// Boltzmann-entropi per rute av tilstanden
		g.to(this.ent);
		g.use(this.eP);
		g.sampler(this.eP, 'uS', 0, this.s[this.cur].tex);
		g.quad();
		this.meter.run(ctx, this.ent, 0, 0);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { W, H, view } = this.pre;
		const w = this.win(ctx);
		g.use(this.dP);
		g.sampler(this.dP, 'uS', 0, this.s[this.cur].tex);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform2i(this.dP.u('uSize'), W, H);
		gl.uniform2f(this.dP.u('uWin'), w[0], w[1]);
		gl.uniform1i(this.dP.u('uMode'), this.phase === 'live' ? 0 : view === 1 ? 2 : 1);
		g.quad();
	}

	meters(): Meters {
		const { P, label } = this.pre;
		const S = this.eS.step(this.meter.globalA * SMAX, 0.35);
		return {
			gauge: clamp01(S / 3.5),
			ruler: this.phase === 'live' ? 0 : clamp01(this.k / P),
			value: S.toFixed(2),
			chip: 'BIT',
			params: `${label} ${this.k}`,
			rulerEnds: ['0', 'P']
		};
	}

	dispose() {
		this.free();
	}
}
