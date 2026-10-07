import type { Prog } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, clamp01 } from './common';

/**
 * Khronos. Trykk inn skjermen, så går tida bakover under fingeren.
 *
 * Kameraet hugsar dei siste to sekunda i ein ringbuffer (60 bilete). Ein finger på skjermen grev ei lomme i
 * tida: jo lenger du held, jo lenger attende ser du, med ein glatt overgang ut til notida. Etter Cassinelli og
 * Ishikawas Khronos Projector (2005), som gjorde det same på ein trykkfølsam lerretsskjerm.
 *
 * Det er ikkje ei snuing av tida. Verda gjer seg ikkje om. Det er minnet som blir vist, og minnet er kostnaden:
 * kvar bit i bufferen måtte sleppast ut som varme for å bli skriven (Landauer, kT·ln2 per bit). Ei pil i verda,
 * ein ring av tilbakeblikk i kameraet.
 */
const K = 60;
const DMAX = K - 1;

interface Preset {
	mode: 0 | 1 | 2 | 3 | 4;
	/** radius i breidder */
	R: number;
	label: string;
	note: string;
}
const PRESETS: Preset[] = [
	{ mode: 0, R: 0.28, label: 'LOMME', note: 'Ei lomme i tida under fingeren. Hald lenger for å gå lenger attende.' },
	{ mode: 0, R: 0.58, label: 'STOR', note: 'Større lomme. Jo større flate, jo meir av verda er frå før.' },
	{ mode: 1, R: 0.28, label: 'RING', note: 'Snudd: notida er under fingeren, alt anna er frå før.' },
	{ mode: 2, R: 0.13, label: 'BAND', note: 'Eit band av fortid på tvers. Dra opp og ned.' },
	{ mode: 3, R: 1, label: 'SPOLE', note: 'Heile biletet spolar. Dra til venstre for å gå attende.' }
];

const FS_COPY = `
uniform sampler2D uSrc;
void main() { o = texture(uSrc, vUv); }`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2DArray uArr;
uniform float uHead;
uniform float uFilled;
uniform vec2 uT;
uniform float uD;
uniform float uR;
uniform int uMode;
uniform float uAsp;
float bump(vec2 uv) {
	vec2 d = uv - uT;
	d.y *= uAsp;
	return smoothstep(uR, 0.0, length(d));
}
float delayAt(vec2 uv) {
	float d = 0.0;
	if (uMode == 0) d = uD * bump(uv);
	else if (uMode == 1) d = uD * (1.0 - bump(uv));
	else if (uMode == 2) d = uD * smoothstep(uR, 0.0, abs((uv.y - uT.y) * uAsp));
	else d = uD;
	return clamp(d, 0.0, max(uFilled - 1.0, 0.0));
}
void main() {
	float d = delayAt(vUv);
	vec3 live = camera(vUv);
	vec3 col = live;
	if (d > 0.001) {
		float p = uHead - d;
		p -= ${K}.0 * floor(p / ${K}.0);
		float l0 = floor(p);
		float f = p - l0;
		float l1 = mod(l0 + 1.0, ${K}.0);
		vec3 a = texture(uArr, vec3(vUv, l0)).rgb;
		vec3 b = texture(uArr, vec3(vUv, l1)).rgb;
		vec3 past = mix(a, b, f);
		// fortida er litt kald og bleik, som gamal film
		float k = smoothstep(0.0, 14.0, d);
		float pl = dot(past, vec3(0.2126, 0.7152, 0.0722));
		past = mix(past, vec3(pl), 0.30 * k) * mix(vec3(1.0), vec3(0.88, 0.96, 1.08), k);
		col = mix(live, past, smoothstep(0.0, 1.0, d));
	}
	// ein tynn kant der lomma tek til
	float rim = smoothstep(0.0, 3.0, d) * (1.0 - smoothstep(3.0, 9.0, d));
	col += vec3(rim * 0.16);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Khronos implements Setup {
	readonly info: SetupInfo = {
		id: 'khronos',
		code: 'TIM',
		group: 'tid',
		name: 'Khronos',
		blurb: 'Kameraet hugsar to sekund. Trykk og hald: tida går bakover under fingeren.',
		how: 'Hald fingeren nede og dra rundt. Slepp: tida kjem tilbake.',
		needsFloat: false,
		probe: true,
		press: true
	};

	private gl!: WebGL2RenderingContext;
	private cP!: Prog;
	private dP!: Prog;
	private arr: WebGLTexture | null = null;
	private fbo: WebGLFramebuffer | null = null;
	private head = -1;
	private filled = 0;
	private pr = 0;
	private down = false;
	private tx = 0.5;
	private ty = 0.5;
	private D = 0;

	init(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		this.gl = gl;
		this.cP = g.prog('tim.copy', FS_COPY);
		this.dP = g.prog('tim.draw', FS_DRAW);
		this.arr = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arr);
		gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, ctx.w, ctx.h, K);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.fbo = gl.createFramebuffer();
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	touch(_ctx: Ctx, x: number, y: number, down: boolean) {
		this.down = down;
		if (down) {
			this.tx = x;
			this.ty = y;
		}
	}

	cycle(): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.D = 0;
		return this.pre.note;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;

		// 1. skriv notida inn i ringen
		this.head = (this.head + 1) % K;
		this.filled = Math.min(K, this.filled + 1);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.arr, 0, this.head);
		gl.viewport(0, 0, ctx.w, ctx.h);
		g.use(this.cP);
		g.sampler(this.cP, 'uSrc', 0, ctx.cur.tex);
		g.quad();
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		// 2. djupna: veks medan fingeren er nede, glid attende til notida når han slepp
		const maxD = Math.max(0, this.filled - 1);
		if (this.down) {
			if (this.pre.mode === 3) {
				const target = (1 - this.tx) * maxD;
				this.D += (target - this.D) * 0.4;
			} else {
				this.D = Math.min(maxD, this.D + 1.3);
			}
		} else {
			this.D = this.D < 0.05 ? 0 : this.D * 0.8;
		}
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { mode, R } = this.pre;
		g.use(this.dP);
		g.sampler(this.dP, 'uArr', 0, this.arr, gl.TEXTURE_2D_ARRAY);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.dP.u('uHead'), this.head);
		gl.uniform1f(this.dP.u('uFilled'), this.filled);
		gl.uniform2f(this.dP.u('uT'), this.tx, this.ty);
		gl.uniform1f(this.dP.u('uD'), this.D);
		gl.uniform1f(this.dP.u('uR'), R);
		gl.uniform1i(this.dP.u('uMode'), mode);
		gl.uniform1f(this.dP.u('uAsp'), ctx.sh / ctx.sw);
		g.quad();
	}

	meters(): Meters {
		return {
			gauge: clamp01(this.filled / K),
			ruler: clamp01(this.D / DMAX),
			value: (this.D / 30).toFixed(1),
			chip: 'S',
			params: this.pre.label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		if (this.arr) this.gl?.deleteTexture(this.arr);
		if (this.fbo) this.gl?.deleteFramebuffer(this.fbo);
		this.arr = null;
		this.fbo = null;
	}
}
