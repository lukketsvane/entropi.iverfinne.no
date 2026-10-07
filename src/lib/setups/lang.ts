import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Open Shutter. Lang eksponering: tida som snitt.
 *
 * Kameraet legg saman bilete over tid i eit glidande snitt med tidskonstant τ. Det som står stille vert skarpt.
 * Det som rører seg vert utvaska til det er borte: folk som går forbi blir spøkelsa og så ingenting. Michael
 * Wesely lèt lukkaren stå open i månader (Open Shutter, 2001 til 2004), og bygg døme forsvinn, medan det som står att
 * står der. «MAKS» tek det lysaste kvar piksel har sett i staden for snittet, og lèt det døy sakte ut: lysspor.
 *
 * Eit snitt over tid er ei grovkorning i tid: det held att det som ikkje endrar seg, og kastar resten.
 * Talet er kor mange bit biletet no er forskjellig frå snittet, ½·log2(1 + (Δ/σ)²) med σ = 8 gråtrinn.
 * Det er det eksponeringa har gløymt.
 */
type Kind = 0 | 1; // 0 = snitt, 1 = maks med utdøying

interface Preset {
	kind: Kind;
	/** tidskonstant i bilete, 0 = alt sidan start */
	tau: number;
	ghost: number;
	label: string;
	note: string;
}
const PRESETS: Preset[] = [
	{ kind: 0, tau: 150, ghost: 0.16, label: 'T5S', note: 'Eksponering 5 sekund. Det som rører seg vert utvaska, det som står stille vert skarpt.' },
	{ kind: 0, tau: 900, ghost: 0.16, label: 'T30S', note: 'Eksponering 30 sekund. Folk som går forbi forsvinn.' },
	{ kind: 0, tau: 0, ghost: 0.16, label: 'ALT', note: 'Eksponering frå du opna. Snittet av alt kameraet har sett.' },
	{ kind: 1, tau: 0, ghost: 0, label: 'MAKS', note: 'Lysspor. Det lysaste kvar piksel har sett, og det døyr sakte ut.' }
];
const SIGMA = 8;
const BMAX = 4;

const FS_UPDATE = `
uniform sampler2D uFrame;
uniform sampler2D uAcc;
uniform float uA;
uniform int uKind;
uniform float uDecay;
void main() {
	vec3 x = texture(uFrame, vUv).rgb;
	vec3 a = texture(uAcc, vUv).rgb;
	vec3 r = uKind == 0 ? mix(a, x, uA) : max(x, a * uDecay);
	o = vec4(r, 1.0);
}`;

const FS_MAP = `
uniform sampler2D uFrame;
uniform sampler2D uAcc;
void main() {
	vec3 d = (texture(uFrame, vUv).rgb - texture(uAcc, vUv).rgb) * 255.0;
	float bits = 0.5 * log2(1.0 + dot(d, d) / (3.0 * ${SIGMA}.0 * ${SIGMA}.0));
	o = vec4(min(bits / ${BMAX}.0, 1.0), 0.0, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uAcc;
uniform float uGhost;
void main() {
	vec3 a = texture(uAcc, vUv).rgb;
	vec3 col = mix(a, camera(vUv), uGhost);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Lang implements Setup {
	readonly info: SetupInfo = {
		id: 'lang',
		code: 'LAN',
		name: 'Open Shutter',
		blurb: 'Lang eksponering. Det som rører seg forsvinn, det som står stille vert att.',
		how: 'Set telefonen i ro. La folk gå forbi, eller veiv. Trykk på talet nede til høgre for lengre eksponering.',
		needsFloat: true,
		probe: true
	};

	private uP!: Prog;
	private mP!: Prog;
	private dP!: Prog;
	private acc: Target[] = [];
	private ai = 0;
	private map!: Target;
	private meter!: MapMeter;
	private pr = 0;
	/** bilete sidan sist nullstilling, for «alt» */
	private n = 0;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.uP = g.prog('lan.update', FS_UPDATE);
		this.mP = g.prog('lan.map', FS_MAP);
		this.dP = g.prog('lan.draw', FS_DRAW);
		const f = g.floatFmt();
		this.acc = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.n = 0;
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	cycle(): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.n = 0;
		this.eG.reset();
		this.eS.reset();
		return this.pre.note;
	}

	tap(): boolean {
		// trykk: start eksponeringa på nytt
		this.n = 0;
		return false;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { kind, tau } = this.pre;
		const out = this.acc[1 - this.ai];
		const a = tau > 0 ? (this.n === 0 ? 1 : 1 / tau) : 1 / (this.n + 1);

		g.to(out);
		g.use(this.uP);
		g.sampler(this.uP, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.uP, 'uAcc', 1, this.acc[this.ai].tex);
		gl.uniform1f(this.uP.u('uA'), this.n === 0 ? 1 : a);
		gl.uniform1i(this.uP.u('uKind'), kind);
		gl.uniform1f(this.uP.u('uDecay'), 0.992);
		g.quad();

		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.mP, 'uAcc', 1, this.acc[this.ai].tex);
		g.quad();

		this.ai ^= 1;
		this.n++;
		this.meter.run(ctx, this.map, 0, 0);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uAcc', 0, this.acc[this.ai].tex);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.dP.u('uGhost'), this.pre.ghost);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const gm = this.eG.step(m.globalA * BMAX, 0.3);
		const sp = this.eS.step(m.spotA * BMAX, 0.3);
		return {
			gauge: clamp01(gm / 1.2),
			ruler: clamp01(sp / 3),
			value: gm.toFixed(2),
			chip: 'BIT',
			params: this.pre.label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.acc.forEach((t) => t.del());
		this.map?.del();
		this.meter?.dispose();
	}
}
