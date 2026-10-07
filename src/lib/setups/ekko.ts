import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Ekko. Eit kamera som ser seg sjølv.
 *
 * Kvart nytt bilete er det førre, litt zooma og vridd, lagt inn att i seg sjølv: x' = c + R(θ)(x − c)/z. Det er
 * den gamle videotilbakekoplinga frå 1970-åra (kamera peikt mot sin eigen skjerm), rekna ut i staden for filma.
 * Ei slik løkke har ingen fast tilstand å kome til. Ein liten skilnad i inngangen vert forsterka for kvart
 * rundt (Lyapunov), og etter nokre dusin rundar er biletet ein virvel som hugsar lite av det som starta han.
 *
 * Kameraet slepp inn på to måtar. DROSTE: kameraet er utanfor ei lita ramme, og inni rammen ligg førre bilete.
 * Det er det same som å sette kameraet framfor skjermen. Elles slepp berre det som rører seg inn (bilete-
 * differansen), og resten av biletet er det løkka sjølv har laga.
 *
 * Talet er kor langt løkka har vandra frå kameraet, i bit per piksel: ½·log2(1 + z²), z = (ekko − kamera)/σ.
 * Held du kameraet stille og lèt løkka gå, veks det. Det er minnet som har blitt til støy.
 */
const SIGMA = 6;
const BMAX = 6;

interface Preset {
	label: string;
	note: string;
	zoom: number;
	/** grader per bilete */
	rot: number;
	/** fargevridning i grader per bilete */
	hue: number;
	/** kor mykje kamera som alltid slepp inn */
	seed: number;
	/** kor mykje det som rører seg slepp inn */
	mot: number;
	/** kaleidoskop: tal på sektorar, 0 = av */
	fold: number;
	/** 1 = kameraet er utanfor rammen, ekkoet inni */
	droste: 0 | 1;
	decay: number;
}

const PRESETS: Preset[] = [
	{
		label: 'DROSTE',
		note: 'Kameraet står framfor skjermen sin. Kvart bilete ligg i ei ramme i det førre.',
		zoom: 0.9,
		rot: 4,
		hue: 0,
		seed: 0,
		mot: 0,
		fold: 0,
		droste: 1,
		decay: 1
	},
	{
		label: 'TUNNEL',
		note: 'Zoom inn og fargevridning. Berre det som rører seg slepp inn.',
		zoom: 1.035,
		rot: 0,
		hue: 9,
		seed: 0.012,
		mot: 1,
		fold: 0,
		droste: 0,
		decay: 0.996
	},
	{
		label: 'VIRVEL',
		note: 'Vridning og litt zoom. Spor frå handa vert til spiralar.',
		zoom: 1.008,
		rot: 5,
		hue: 5,
		seed: 0.02,
		mot: 1,
		fold: 0,
		droste: 0,
		decay: 0.995
	},
	{
		label: 'SPEIL',
		note: 'Seks speglar. Løkka er symmetrisk, så alt som kjem inn vert ein mandala.',
		zoom: 1.02,
		rot: 2,
		hue: 6,
		seed: 0.015,
		mot: 1,
		fold: 6,
		droste: 0,
		decay: 0.996
	}
];

const HUE = `
vec3 hueRot(vec3 c, float a) {
	const vec3 k = vec3(0.57735027);
	float cs = cos(a);
	float sn = sin(a);
	return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}`;

const FS_STEP = `${HUE}
uniform sampler2D uF;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform vec2 uC;
uniform float uAsp;
uniform float uZoom;
uniform float uRot;
uniform float uHue;
uniform float uDecay;
uniform float uSeed;
uniform float uMot;
uniform float uFold;
uniform float uDroste;
uniform float uPhase;
uniform float uFirst;
vec2 mirror(vec2 t) { return 1.0 - abs(1.0 - mod(t, 2.0)); }
void main() {
	vec3 cam = texture(uCur, vUv).rgb;
	if (uFirst > 0.5) { o = vec4(cam, 1.0); return; }
	vec2 p = (vUv - uC) * vec2(uAsp, 1.0);
	if (uFold > 0.5) {
		float r = length(p);
		float a = atan(p.y, p.x);
		float s = 6.2831853 / uFold;
		a = abs(mod(a, s) - 0.5 * s);
		p = r * vec2(cos(a), sin(a));
	}
	float cs = cos(uRot);
	float sn = sin(uRot);
	vec2 q = vec2(cs * p.x + sn * p.y, -sn * p.x + cs * p.y) / uZoom;
	vec2 uv = uC + q / vec2(uAsp, 1.0);
	vec3 f = texture(uF, mirror(uv)).rgb;
	if (uHue != 0.0) f = hueRot(f, uHue);
	f *= uDecay;
	if (uDroste > 0.5) {
		bool inside = all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)));
		o = vec4(inside ? f : cam, 1.0);
		return;
	}
	float d = abs(texture(uCur, vUv).a - texture(uPrev, vUv).a);
	float m = smoothstep(0.03, 0.12, d) * uMot;
	vec3 inj = hueRot(cam, uPhase);
	f = mix(f, inj, clamp(max(m, uSeed), 0.0, 1.0));
	o = vec4(clamp(f, 0.0, 1.0), 1.0);
}`;

const FS_MAP = `
uniform sampler2D uF;
uniform sampler2D uCur;
void main() {
	vec3 r = (texture(uF, vUv).rgb - texture(uCur, vUv).rgb) * 255.0;
	float z2 = dot(r, r) / (3.0 * ${SIGMA * SIGMA}.0);
	float bits = 0.5 * log2(1.0 + z2);
	o = vec4(min(bits / ${BMAX}.0, 1.0), 0.0, 0.0, 1.0);
}`;

const FS_DRAW = `
uniform sampler2D uF;
void main() {
	vec3 col = texture(uF, vUv).rgb;
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Ekko implements Setup {
	readonly info: SetupInfo = {
		id: 'ekko',
		code: 'EKK',
		group: 'dyn',
		name: 'Ekko',
		blurb: 'Kameraet ser seg sjølv. Kvart bilete er det førre, litt vridd, lagt oppå seg sjølv.',
		how: 'Veiv med handa: det som rører seg vert dregen inn i løkka. Hald fingeren nede for å flytte midten.',
		needsFloat: true,
		probe: true,
		press: true,
		still: true
	};

	private sP!: Prog;
	private mP!: Prog;
	private dP!: Prog;
	private f: Target[] = [];
	private fi = 0;
	private map!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private c: [number, number] = [0.5, 0.5];
	private first = true;
	private phase = 0;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.sP = g.prog('ekk.step', FS_STEP);
		this.mP = g.prog('ekk.map', FS_MAP);
		this.dP = g.prog('ekk.draw', FS_DRAW);
		const k = Math.min(0.7, Math.sqrt(700_000 / (ctx.sw * ctx.sh)));
		const w = Math.max(64, Math.round(ctx.sw * k));
		const h = Math.max(64, Math.round(ctx.sh * k));
		this.f = [g.target(w, h, g.F16, true), g.target(w, h, g.F16, true)];
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.c = [ctx.probe[0], ctx.probe[1]];
		this.first = true;
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	touch(_ctx: Ctx, x: number, y: number, down: boolean) {
		if (down) this.c = [x, y];
	}

	cycle(): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.first = true;
		this.eG.reset();
		this.eS.reset();
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const p = this.pre;
		const src = this.f[this.fi];
		const dst = this.f[1 - this.fi];
		this.phase += 0.02;

		g.to(dst);
		g.use(this.sP);
		g.sampler(this.sP, 'uF', 0, src.tex);
		g.sampler(this.sP, 'uCur', 1, ctx.cur.tex);
		g.sampler(this.sP, 'uPrev', 2, ctx.prev.tex);
		gl.uniform2f(this.sP.u('uC'), this.c[0], this.c[1]);
		gl.uniform1f(this.sP.u('uAsp'), dst.w / dst.h);
		gl.uniform1f(this.sP.u('uZoom'), p.zoom);
		gl.uniform1f(this.sP.u('uRot'), (p.rot * Math.PI) / 180);
		gl.uniform1f(this.sP.u('uHue'), (p.hue * Math.PI) / 180);
		gl.uniform1f(this.sP.u('uDecay'), p.decay);
		gl.uniform1f(this.sP.u('uSeed'), p.seed);
		gl.uniform1f(this.sP.u('uMot'), p.mot);
		gl.uniform1f(this.sP.u('uFold'), p.fold);
		gl.uniform1f(this.sP.u('uDroste'), p.droste);
		gl.uniform1f(this.sP.u('uPhase'), this.phase);
		gl.uniform1f(this.sP.u('uFirst'), this.first || ctx.frameNo < 1 ? 1 : 0);
		g.quad();
		this.fi ^= 1;
		this.first = false;

		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uF', 0, this.f[this.fi].tex);
		g.sampler(this.mP, 'uCur', 1, ctx.cur.tex);
		g.quad();
		this.meter.run(ctx, this.map, 0, 0);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		void ctx;
		g.use(this.dP);
		g.sampler(this.dP, 'uF', 0, this.f[this.fi].tex);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const gm = this.eG.step(m.globalA * BMAX, 0.3);
		const sp = this.eS.step(m.spotA * BMAX, 0.3);
		return {
			gauge: clamp01(gm / 3),
			ruler: clamp01(sp / 4),
			value: gm.toFixed(2),
			chip: 'BIT',
			params: this.pre.label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.f.forEach((t) => t.del());
		this.map?.del();
		this.meter?.dispose();
	}
}
