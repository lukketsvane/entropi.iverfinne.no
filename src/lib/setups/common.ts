import type { Gfx, Prog, Target } from '../engine/gl';
import type { Ctx } from '../engine/types';

/** Heile bilete frå kamera til lerret, med cover-skala. Brukt av søkjaren og som botn i dei andre. */
export const COVER_VIDEO = `
uniform sampler2D uVideo;
uniform vec2 uCover;
vec3 camera(vec2 uv) {
	return texture(uVideo, (uv - 0.5) * uCover + 0.5).rgb;
}`;

/** To 16-bits tal i ein RGBA8-piksel, så tilbakelesinga ikkje treng flyttalsformat. */
export const PACK = `
vec2 pack16(float v) {
	float s = clamp(v, 0.0, 1.0) * 255.0;
	float hi = floor(s);
	return vec2(hi / 255.0, s - hi);
}`;

export function unpack16(b: Uint8Array, o: number): number {
	return (b[o] + b[o + 1] / 255) / 255;
}

/** Kvit-varm og kald-kvit fargeskalaer. Berre for visning, ingen tyding. */
export const RAMPS = `
vec3 rampCool(float t) {
	t = clamp(t, 0.0, 1.0);
	vec3 a = vec3(0.0);
	vec3 b = vec3(0.07, 0.10, 0.14);
	vec3 c = vec3(0.52, 0.62, 0.70);
	vec3 d = vec3(1.0);
	vec3 col = mix(a, b, smoothstep(0.0, 0.3, t));
	col = mix(col, c, smoothstep(0.25, 0.75, t));
	col = mix(col, d, smoothstep(0.7, 1.0, t));
	return col;
}
vec3 rampWarm(float t) {
	t = clamp(t, 0.0, 1.0);
	vec3 a = vec3(0.0);
	vec3 b = vec3(0.16, 0.035, 0.015);
	vec3 c = vec3(0.95, 0.42, 0.10);
	vec3 d = vec3(1.0, 0.95, 0.84);
	vec3 col = mix(a, b, smoothstep(0.0, 0.25, t));
	col = mix(col, c, smoothstep(0.2, 0.7, t));
	col = mix(col, d, smoothstep(0.65, 1.0, t));
	return col;
}`;

/**
 * Gjennomsnitt over heile flata og rundt sonden frå ein mipmappa tekstur.
 * Les to kanalar (A og B) → to piksler à 4 byte: [global A, spot A][global B, spot B].
 * Globalt: eksakt snitt over nivå 3 (8x8 piksel per texel, krev at arbeidsbiletet er delbart med 8).
 * Spot: boks på 21x21 texel i nivå 1 (≈ 42x42 arbeidspiksel) rundt sonden.
 */
export class MapMeter {
	private stat: Target;
	private prog: Prog;
	/** siste lesne verdiar, 0..1 */
	globalA = 0;
	spotA = 0;
	globalB = 0;
	spotB = 0;
	globalC = 0;
	spotC = 0;
	/** kor mange lesingar som har kome attende. Ei ny lesing = eit nytt prøvepunkt. */
	count = 0;

	/** nch: talet på kanalar å lese, 2 eller 3 */
	constructor(
		private gfx: Gfx,
		private nch = 2
	) {
		this.stat = gfx.target(nch, 1, gfx.U8, false);
		this.prog = gfx.prog(
			'mapmeter',
			`${PACK}
uniform sampler2D uMap;
uniform vec2 uProbe;
uniform ivec3 uCh;
uniform int uR;
float pick(vec4 c, int k) { return k == 0 ? c.r : k == 1 ? c.g : k == 2 ? c.b : c.a; }
void main() {
	int i = int(gl_FragCoord.x);
	int ch = i == 0 ? uCh.x : i == 1 ? uCh.y : uCh.z;
	ivec2 s3 = textureSize(uMap, 3);
	float acc = 0.0;
	for (int y = 0; y < s3.y; y++) {
		for (int x = 0; x < s3.x; x++) acc += pick(texelFetch(uMap, ivec2(x, y), 3), ch);
	}
	float g = acc / float(s3.x * s3.y);
	ivec2 s1 = textureSize(uMap, 1);
	ivec2 c = ivec2(uProbe * vec2(s1));
	float sa = 0.0;
	float n = 0.0;
	for (int y = -uR; y <= uR; y++) {
		for (int x = -uR; x <= uR; x++) {
			ivec2 p = c + ivec2(x, y);
			if (p.x >= 0 && p.y >= 0 && p.x < s1.x && p.y < s1.y) {
				sa += pick(texelFetch(uMap, p, 1), ch);
				n += 1.0;
			}
		}
	}
	o = vec4(pack16(g), pack16(n > 0.0 ? sa / n : 0.0));
}`
		);
	}

	/** map må vere laga med mips. chA/chB: kanal 0..3. Lesinga kjem 1 til 3 bilete seinare. */
	run(ctx: Ctx, map: Target, chA: number, chB: number, chC = 0) {
		const g = this.gfx;
		const gl = g.gl;
		g.mipmap(map);
		g.to(this.stat);
		g.use(this.prog);
		g.sampler(this.prog, 'uMap', 0, map.tex);
		gl.uniform2f(this.prog.u('uProbe'), ctx.probe[0], ctx.probe[1]);
		gl.uniform3i(this.prog.u('uCh'), chA, chB, chC);
		gl.uniform1i(this.prog.u('uR'), 10);
		g.quad();
		ctx.read(this.stat, 0, 0, this.nch, 1, (b) => {
			this.globalA = unpack16(b, 0);
			this.spotA = unpack16(b, 2);
			this.globalB = unpack16(b, 4);
			this.spotB = unpack16(b, 6);
			if (this.nch > 2) {
				this.globalC = unpack16(b, 8);
				this.spotC = unpack16(b, 10);
			}
			this.count++;
		});
	}

	dispose() {
		this.stat.del();
	}
}

/**
 * Globale snitt av opptil 16 kanalar frå opptil fire mipmappa kart (RGBA, 0..1) i éi lesing.
 * Kanal i ligg i kart i>>2, komponent i&3. Snittet er eksakt over nivå 3 (8x8 per texel) når
 * kartet er delbart med 8. Resultatet kjem 1 til 3 bilete seinare i v[i] (0..1, 16 bit).
 * Éi lesing om gongen i heile motoren: bruk éin Reducer eller éin MapMeter per oppsett.
 */
export class Reducer {
	private stat: Target;
	private prog: Prog;
	/** siste lesne snitt */
	v: number[];
	/** kor mange lesingar som har kome attende */
	count = 0;

	constructor(
		private gfx: Gfx,
		readonly nch: number
	) {
		if (nch < 1 || nch > 16) throw new Error('Reducer: 1..16 kanalar');
		this.stat = gfx.target(nch, 1, gfx.U8, false);
		this.v = new Array<number>(nch).fill(0);
		const loop = (m: number) => `
	if (m == ${m}) {
		ivec2 s = textureSize(uM${m}, 3);
		for (int y = 0; y < s.y; y++) {
			for (int x = 0; x < s.x; x++) acc += pick(texelFetch(uM${m}, ivec2(x, y), 3), ch);
		}
		n = float(s.x * s.y);
	}`;
		this.prog = gfx.prog(
			'reducer',
			`${PACK}
uniform sampler2D uM0;
uniform sampler2D uM1;
uniform sampler2D uM2;
uniform sampler2D uM3;
float pick(vec4 c, int k) { return k == 0 ? c.r : k == 1 ? c.g : k == 2 ? c.b : c.a; }
void main() {
	int i = int(gl_FragCoord.x);
	int m = i >> 2;
	int ch = i & 3;
	float acc = 0.0;
	float n = 1.0;${loop(0)}${loop(1)}${loop(2)}${loop(3)}
	o = vec4(pack16(acc / n), 0.0, 0.0);
}`
		);
	}

	/** maps: éin Target per fire kanalar, laga med mips (F16). Manglar eit kart, vert sampleren bunden til det første. */
	run(ctx: Ctx, maps: Target[]) {
		const g = this.gfx;
		const gl = g.gl;
		const k = Math.ceil(this.nch / 4);
		for (let i = 0; i < k; i++) g.mipmap(maps[i]);
		g.to(this.stat);
		g.use(this.prog);
		for (let i = 0; i < 4; i++) g.sampler(this.prog, `uM${i}`, i, maps[Math.min(i, k - 1)].tex);
		void gl;
		g.quad();
		ctx.read(this.stat, 0, 0, this.nch, 1, (b) => {
			for (let i = 0; i < this.nch; i++) this.v[i] = unpack16(b, i * 4);
			this.count++;
		});
	}

	dispose() {
		this.stat.del();
	}
}

/** Mjuk tal-glatting for HUD-en, så ikkje siffera hoppar. */
export class Ease {
	v = 0;
	private init = false;
	step(target: number, k = 0.35): number {
		if (!this.init) {
			this.v = target;
			this.init = true;
		} else this.v += (target - this.v) * k;
		return this.v;
	}
	/** Neste verdi hoppar rett til målet i staden for å glei dit. */
	reset() {
		this.init = false;
	}
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
