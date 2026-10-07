import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Tidsfarge. Kor lenge sidan noko rørte seg her?
 *
 * Kvar piksel hugsar alderen på siste rørsle, i bilete: 0 når han endra seg meir enn terskelen (målt på eit
 * lett utjamna bilete, så sensorstøy ikkje tel), elles +1. Alderen vert fargelagt frå kvitt (nett no) via gult og
 * raudt til blått og mørkt (for lenge sidan), over ein horisont H. Ei hand som sveipar over biletet legg att eit
 * spor der fargen er tida: som kronofotografiet til Marey, men med tida som fargetone.
 *
 * Tidsrekkja går berre éi veg. Sporet strekkjer seg bakover, aldri framover: det er pila, utan statistikk.
 * I «ring»-oppsettet går fargen rundt éin gong per sekund, så ein kan telje sekund og lese fart av avstanden mellom ringane.
 */
interface Preset {
	/** horisont, bilete */
	H: number;
	/** ringlengd i bilete, 0 = fargen følgjer horisonten */
	ring: number;
	/** terskel, gråtrinn */
	thr: number;
	note: string;
	label: string;
}
const PRESETS: Preset[] = [
	{ H: 90, ring: 0, thr: 5, label: 'H3S', note: 'Fargen er tida: kvitt er nett no, blått for tre sekund sidan.' },
	{ H: 240, ring: 30, thr: 5, label: 'RING 1S', note: 'Ein ring per sekund. Tel ringane: det er sekund. Avstanden er fart.' },
	{ H: 600, ring: 0, thr: 5, label: 'H20S', note: 'Tjue sekund minne. Sporet døyr ut sakte.' },
	{ H: 90, ring: 0, thr: 14, label: 'H3S GROV', note: 'Berre store rørsler set spor.' }
];

const FS_UPDATE = `
uniform sampler2D uFrame;
uniform sampler2D uPrevF;
uniform sampler2D uAge;
uniform float uThr;
uniform float uMax;
uniform float uLive;
float blur(sampler2D t, vec2 uv) {
	vec2 px = 0.5 / vec2(textureSize(t, 0));
	return 0.25 * (texture(t, uv + vec2(-px.x, -px.y)).a + texture(t, uv + vec2(px.x, -px.y)).a
		+ texture(t, uv + vec2(-px.x, px.y)).a + texture(t, uv + vec2(px.x, px.y)).a);
}
void main() {
	float d = abs(blur(uFrame, vUv) - blur(uPrevF, vUv)) * 255.0;
	float age = texture(uAge, vUv).r;
	age = (d >= uThr && uLive > 0.5) ? 0.0 : min(age + 1.0, uMax);
	o = vec4(age, 0.0, 0.0, 1.0);
}`;

const FS_MAP = `
uniform sampler2D uAge;
uniform float uH;
void main() {
	float a = texture(uAge, vUv).r;
	o = vec4(min(a / uH, 1.0), a < uH ? 1.0 : 0.0, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uAge;
uniform float uH;
uniform float uRing;
vec3 chrono(float t) {
	t = clamp(t, 0.0, 1.0);
	vec3 c0 = vec3(1.00, 0.97, 0.86);
	vec3 c1 = vec3(1.00, 0.80, 0.22);
	vec3 c2 = vec3(0.96, 0.30, 0.10);
	vec3 c3 = vec3(0.70, 0.10, 0.52);
	vec3 c4 = vec3(0.22, 0.24, 0.90);
	vec3 c5 = vec3(0.10, 0.62, 0.78);
	vec3 col = mix(c0, c1, smoothstep(0.00, 0.14, t));
	col = mix(col, c2, smoothstep(0.12, 0.34, t));
	col = mix(col, c3, smoothstep(0.32, 0.55, t));
	col = mix(col, c4, smoothstep(0.52, 0.78, t));
	col = mix(col, c5, smoothstep(0.76, 1.00, t));
	return col;
}
void main() {
	float age = texture(uAge, vUv).r;
	float t = clamp(age / uH, 0.0, 1.0);
	float a = 1.0 - smoothstep(0.55, 1.0, t);
	a *= step(age, uH - 0.5);
	float cph = uRing > 0.0 ? fract(age / uRing) : sqrt(t);
	vec3 c = camera(vUv);
	float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
	vec3 base = vec3(L) * 0.28;
	vec3 hue = chrono(cph) * (0.55 + 0.75 * L);
	vec3 col = mix(base, hue, a * 0.96);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Tidsfarge implements Setup {
	readonly info: SetupInfo = {
		id: 'tidsfarge',
		code: 'FRG',
		name: 'Tidsfarge',
		blurb: 'Fargen er tida. Kvitt er nett no, blått er for lenge sidan.',
		how: 'Sveip handa over biletet. Sporet er tida som gjekk.',
		needsFloat: true,
		probe: true
	};

	private uP!: Prog;
	private mP!: Prog;
	private dP!: Prog;
	private age: Target[] = [];
	private ai = 0;
	private map!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.uP = g.prog('frg.update', FS_UPDATE);
		this.mP = g.prog('frg.map', FS_MAP);
		this.dP = g.prog('frg.draw', FS_DRAW);
		// alderen er heiltal: F16 er eksakt til 2048. Ikkje filtrert, for alder kan ikkje blandast.
		this.age = [g.target(ctx.w, ctx.h, g.F16, false), g.target(ctx.w, ctx.h, g.F16, false)];
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.fill(ctx, 2000);
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	/** alle piksel gamle: ingenting har rørt seg ennå */
	private fill(ctx: Ctx, v: number) {
		const g = ctx.gfx;
		for (const t of this.age) {
			g.to(t);
			g.gl.clearColor(v, 0, 0, 1);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
	}

	cycle(): string {
		const hOld = this.pre.H;
		this.pr = (this.pr + 1) % PRESETS.length;
		this.eG.reset();
		this.eS.reset();
		// alderen vert kutta ved horisonten: ein lengre horisont gir ikkje attende spor som alt er kutta
		void hOld;
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { H, thr } = this.pre;
		const out = this.age[1 - this.ai];
		g.to(out);
		g.use(this.uP);
		g.sampler(this.uP, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.uP, 'uPrevF', 1, ctx.prev.tex);
		g.sampler(this.uP, 'uAge', 2, this.age[this.ai].tex);
		gl.uniform1f(this.uP.u('uThr'), thr);
		gl.uniform1f(this.uP.u('uMax'), 2000);
		gl.uniform1f(this.uP.u('uLive'), ctx.frameNo < 2 ? 0 : 1);
		g.quad();
		this.ai ^= 1;

		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uAge', 0, out.tex);
		gl.uniform1f(this.mP.u('uH'), H);
		g.quad();
		this.meter.run(ctx, this.map, 1, 0);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { H, ring } = this.pre;
		g.use(this.dP);
		g.sampler(this.dP, 'uAge', 0, this.age[this.ai].tex);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.dP.u('uH'), H);
		gl.uniform1f(this.dP.u('uRing'), ring);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const { H, label } = this.pre;
		// A = delen piksel som har rørt seg innanfor horisonten, B = alder på sonden som del av horisonten
		const act = this.eG.step(m.globalA, 0.3);
		const age = this.eS.step(m.spotB, 0.3);
		return {
			gauge: clamp01(act / 0.6),
			ruler: clamp01(age),
			value: ((age * H) / 30).toFixed(1),
			chip: 'S',
			params: label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.age.forEach((t) => t.del());
		this.map?.del();
		this.meter?.dispose();
	}
}
