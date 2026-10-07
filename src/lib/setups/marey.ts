import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Marey. Eit stroboskop som set att stillbilete av alt som rører seg.
 *
 * Kameraet lærer korleis rommet ser ut utan deg (eit sakte snitt som ikkje lèt seg trekkje med av det som rører seg),
 * og alt som skil seg frå det er rørsle. Fleire gonger i sekundet vert rørsla stempla fast på eit lerret som sakte
 * bleiknar: ei svinga hand vert ei vifte av hender, ein gåande vert ei rekkje av gåande. Étienne-Jules Marey
 * gjorde det same på ei einskild glasplate i 1882, tolv bilete i sekundet, med ei fotografisk børse.
 * Eadweard Muybridge, Harold Edgerton og alle stroboskopbilete sidan følgjer same prinsipp.
 *
 * Talet er kor mange bit som trengst for å seie kvar rørsla har vore: Shannon-entropien til fordelinga av
 * spor over 8x8-ruter, over dei siste sekunda. Ei hand som svingar på éin stad gir få bit. Ein som går på tvers
 * av biletet gir mange. Ingen rørsle gir ingen tal.
 *
 * Kameraet må stå i ro. Trykk for å nullstille det kameraet trur er «rommet».
 */
interface Preset {
	/** sekund mellom stempel */
	every: number;
	/** halveringstid for spøkelsa, sekund */
	life: number;
	/** 0 = bilete, 1 = kontur på svart plate */
	mode: 0 | 1;
	opacity: number;
	label: string;
	note: string;
}
const PRESETS: Preset[] = [
	{
		every: 1 / 6,
		life: 1.5,
		mode: 0,
		opacity: 0.8,
		label: 'TETT',
		note: 'Seks stillbilete i sekundet av alt som rører seg. Svinga handa vert ei vifte.'
	},
	{
		every: 1 / 12,
		life: 1.8,
		mode: 1,
		opacity: 1,
		label: 'MAREY',
		note: 'Marey, 1882: tolv bilete i sekundet. Berre konturen, kvit strek på svart plate.'
	},
	{
		every: 1 / 3,
		life: 3,
		mode: 0,
		opacity: 0.65,
		label: 'GLAS',
		note: 'Tre bilete i sekundet, lengre minne. Ein som går vert ei rekkje.'
	},
	{
		every: 1 / 30,
		life: 0.7,
		mode: 0,
		opacity: 1,
		label: 'HALE',
		note: 'Eit bilete for kvart bilete, kort minne. Alt som rører seg drar ei hale.'
	}
];

/** hastigheit på bakgrunnsinnlæring: utan rørsle, under rørsle, og der noko skil seg frå rommet men står i ro */
const A_BG = 1 / 50;
const A_FG = 1 / 600;
const A_STILL = 1 / 75;
const CELL = 8;

const FS_MASK = `
uniform sampler2D uX;
uniform sampler2D uB;
void main() {
	vec2 px = 1.0 / vec2(textureSize(uX, 0));
	vec3 x = 0.25 * (texture(uX, vUv + vec2(-0.5, -0.5) * px).rgb + texture(uX, vUv + vec2(0.5, -0.5) * px).rgb
		+ texture(uX, vUv + vec2(-0.5, 0.5) * px).rgb + texture(uX, vUv + vec2(0.5, 0.5) * px).rgb);
	ivec2 p = ivec2(gl_FragCoord.xy);
	ivec2 hi = textureSize(uB, 0) - 1;
	// Nærmaste rom innanfor ±2 piksel: ein tråd som skaklar litt er ikkje rørsle.
	float dm = 1e9;
	for (int j = -2; j <= 2; j++) {
		for (int i = -2; i <= 2; i++) {
			vec3 b = texelFetch(uB, clamp(p + ivec2(i, j), ivec2(0), hi), 0).rgb;
			dm = min(dm, length(x - b));
		}
	}
	o = vec4(smoothstep(12.0, 34.0, dm * 255.0), 0.0, 0.0, 1.0);
}`;

const FS_BG = `
uniform sampler2D uX;
uniform sampler2D uP;
uniform sampler2D uB;
uniform sampler2D uM;
uniform float uFresh;
uniform float uA0;
uniform float uA1;
uniform float uA2;
vec3 soft(sampler2D t, vec2 uv, vec2 px) {
	return 0.25 * (texture(t, uv + vec2(-0.5, -0.5) * px).rgb + texture(t, uv + vec2(0.5, -0.5) * px).rgb
		+ texture(t, uv + vec2(-0.5, 0.5) * px).rgb + texture(t, uv + vec2(0.5, 0.5) * px).rgb);
}
void main() {
	vec2 px = 1.0 / vec2(textureSize(uM, 0));
	float m = 0.0;
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) m = max(m, texture(uM, vUv + vec2(float(i), float(j)) * 2.0 * px).r);
	}
	vec3 x = texture(uX, vUv).rgb;
	// ro i tid: ei flate som ikkje skiftar frå bilete til bilete er ikkje rørsle, uansett kva ho likna før
	float dt = length(soft(uX, vUv, px) - soft(uP, vUv, px)) * 255.0;
	float still = 1.0 - smoothstep(3.0, 10.0, dt);
	vec3 b = texelFetch(uB, ivec2(gl_FragCoord.xy), 0).rgb;
	float a = mix(uA0, mix(uA1, uA2, still), m);
	if (uFresh > 0.5) a = 1.0;
	o = vec4(b + (x - b) * a, 1.0);
}`;

const FS_STAMP = `
uniform sampler2D uC;
uniform sampler2D uX;
uniform sampler2D uM;
uniform float uDecay;
uniform float uStamp;
uniform float uClear;
uniform int uMode;
void main() {
	vec4 c = texture(uC, vUv);
	c.a *= uDecay;
	if (uClear > 0.5) c = vec4(0.0);
	if (uStamp > 0.5) {
		float m = texture(uM, vUv).r;
		if (uMode == 1) {
			vec2 px = 1.0 / vec2(textureSize(uM, 0));
			float mn = min(min(texture(uM, vUv + vec2(2.0, 0.0) * px).r, texture(uM, vUv - vec2(2.0, 0.0) * px).r),
				min(texture(uM, vUv + vec2(0.0, 2.0) * px).r, texture(uM, vUv - vec2(0.0, 2.0) * px).r));
			float e = smoothstep(0.12, 0.6, m * (1.0 - mn));
			if (e > c.a) c = vec4(1.0, 1.0, 1.0, e);
		} else {
			vec3 x = texture(uX, vUv).rgb;
			float w = smoothstep(0.35, 0.8, m);
			c = vec4(mix(c.rgb, x, w), max(c.a, w));
		}
	}
	o = c;
}`;

const FS_CELL = `
uniform sampler2D uC;
void main() {
	ivec2 c = ivec2(gl_FragCoord.xy);
	float s = 0.0;
	for (int j = 0; j < ${CELL}; j++) {
		for (int i = 0; i < ${CELL}; i++) s += texelFetch(uC, c * ${CELL} + ivec2(i, j), 0).a;
	}
	float a = s / ${CELL * CELL}.0;
	float h = -a * log2(max(a, 1e-6));
	o = vec4(clamp(a, 0.0, 1.0), clamp(h, 0.0, 1.0), 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uC;
uniform sampler2D uM;
uniform float uOp;
uniform int uMode;
void main() {
	vec3 live = camera(vUv);
	vec4 c = texture(uC, vUv);
	float m = smoothstep(0.35, 0.8, texture(uM, vUv).r);
	vec3 col;
	if (uMode == 1) {
		float L = dot(live, vec3(0.2126, 0.7152, 0.0722));
		vec3 plate = vec3(L) * 0.10;
		vec3 base = mix(plate, live, m);
		vec3 ink = mix(vec3(0.45, 0.75, 1.0), vec3(1.0), c.a);
		col = mix(base, ink, clamp(c.a * 1.2, 0.0, 1.0) * uOp * (1.0 - 0.6 * m));
	} else {
		float a = c.a * (1.0 - m) * uOp;
		vec3 ghost = mix(c.rgb * vec3(0.78, 0.94, 1.18), c.rgb, c.a);
		col = mix(live, ghost, a);
	}
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Marey implements Setup {
	readonly info: SetupInfo = {
		id: 'marey',
		code: 'MAR',
		name: 'Marey',
		blurb: 'Eit stroboskop. Alt som rører seg vert stempla fast som stillbilete.',
		how: 'Lene telefonen mot noko og rør deg framfor han. Trykk for å nullstille rommet. Trykk på talet nede til høgre for anna rytme.',
		needsFloat: true,
		probe: false
	};

	private mP!: Prog;
	private bP!: Prog;
	private sP!: Prog;
	private cP!: Prog;
	private dP!: Prog;
	private m!: Target;
	private bg: Target[] = [];
	private bi = 0;
	private can: Target[] = [];
	private ci = 0;
	private cell!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private fresh = true;
	private clear = true;
	private acc = 0;
	private last = -1;
	private eH = new Ease();
	private eA = new Ease();
	private nCells = 1;

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.mP = g.prog('mar.mask', FS_MASK);
		this.bP = g.prog('mar.bg', FS_BG);
		this.sP = g.prog('mar.stamp', FS_STAMP);
		this.cP = g.prog('mar.cell', FS_CELL);
		this.dP = g.prog('mar.draw', FS_DRAW);
		const f = g.floatFmt();
		this.m = g.target(ctx.w, ctx.h, g.F16, true);
		this.bg = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.can = [g.target(ctx.w, ctx.h, g.F16, true), g.target(ctx.w, ctx.h, g.F16, true)];
		const cw = ctx.w / CELL;
		const ch = ctx.h / CELL;
		this.cell = g.target(cw, ch, g.F16, true, true);
		this.nCells = cw * ch;
		this.meter = new MapMeter(g, 2);
		this.fresh = true;
		this.clear = true;
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	tap(): boolean {
		// nullstill rommet og spøkelsa
		this.fresh = true;
		this.clear = true;
		return true;
	}

	cycle(): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.clear = true;
		this.acc = 0;
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const pre = this.pre;
		const dt = this.last < 0 ? 1 / 30 : Math.min(0.12, Math.max(0.004, (ctx.now - this.last) / 1000));
		this.last = ctx.now;

		// 1. rørsle: kor ulikt er dette biletet frå det kameraet trur er rommet?
		g.to(this.m);
		g.use(this.mP);
		g.sampler(this.mP, 'uX', 0, ctx.cur.tex);
		g.sampler(this.mP, 'uB', 1, this.bg[this.bi].tex);
		g.quad();

		// 2. rommet lærer, men ikkje av det som rører seg
		const bo = 1 - this.bi;
		g.to(this.bg[bo]);
		g.use(this.bP);
		g.sampler(this.bP, 'uX', 0, ctx.cur.tex);
		g.sampler(this.bP, 'uB', 1, this.bg[this.bi].tex);
		g.sampler(this.bP, 'uM', 2, this.m.tex);
		g.sampler(this.bP, 'uP', 3, ctx.prev.tex);
		gl.uniform1f(this.bP.u('uFresh'), this.fresh ? 1 : 0);
		gl.uniform1f(this.bP.u('uA0'), A_BG);
		gl.uniform1f(this.bP.u('uA1'), A_FG);
		gl.uniform1f(this.bP.u('uA2'), A_STILL);
		g.quad();
		this.bi = bo;
		const wasFresh = this.fresh;
		this.fresh = false;

		// 3. stempel: av og til skriv ein ut rørsla på lerretet, og lerretet bleiknar heile tida
		this.acc += dt;
		let stamp = 0;
		if (this.acc >= pre.every) {
			stamp = 1;
			this.acc -= Math.floor(this.acc / pre.every) * pre.every;
		}
		const co = 1 - this.ci;
		g.to(this.can[co]);
		g.use(this.sP);
		g.sampler(this.sP, 'uC', 0, this.can[this.ci].tex);
		g.sampler(this.sP, 'uX', 1, ctx.cur.tex);
		g.sampler(this.sP, 'uM', 2, this.m.tex);
		gl.uniform1f(this.sP.u('uDecay'), Math.pow(0.5, dt / pre.life));
		gl.uniform1f(this.sP.u('uStamp'), wasFresh ? 0 : stamp);
		gl.uniform1f(this.sP.u('uClear'), this.clear ? 1 : 0);
		gl.uniform1i(this.sP.u('uMode'), pre.mode);
		g.quad();
		this.ci = co;
		this.clear = false;

		// 4. kor spreidd er rørsla? Shannon-entropi over 8x8-ruter av sporet
		g.to(this.cell);
		g.use(this.cP);
		g.sampler(this.cP, 'uC', 0, this.can[this.ci].tex);
		g.quad();
		this.meter.run(ctx, this.cell, 0, 1);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uC', 0, this.can[this.ci].tex);
		g.sampler(this.dP, 'uM', 1, this.m.tex);
		g.sampler(this.dP, 'uVideo', 2, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.dP.u('uOp'), this.pre.opacity);
		gl.uniform1i(this.dP.u('uMode'), this.pre.mode);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const A = m.globalA;
		const Bm = m.globalB;
		const has = A > 0.002;
		const H = has ? Math.max(0, Math.log2(this.nCells * A) + Bm / A) : 0;
		const hs = this.eH.step(H, 0.2);
		const as = this.eA.step(A, 0.2);
		const Hmax = Math.log2(this.nCells);
		return {
			gauge: clamp01(hs / Hmax),
			ruler: clamp01(as * 4),
			value: has ? hs.toFixed(1) : '--',
			chip: 'BIT',
			params: this.pre.label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.m?.del();
		this.bg.forEach((t) => t.del());
		this.can.forEach((t) => t.del());
		this.cell?.del();
		this.meter?.dispose();
	}
}
