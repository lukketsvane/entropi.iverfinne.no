import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, RAMPS, clamp01 } from './common';

/**
 * Rom. Lokal entropi: for kvar piksel, histogram av lysnivå (16 nivå) i eit 9x9-vindauge,
 * H = -Σ p·log2 p, maks 4 bit. Flate = 0, tekstur og støy = høgt.
 * Entropi finst berre i forhold til ei grovkorning: her er det 16 nivå og 81 piksel.
 * Endrar du vindauget, endrar du entropien. Det er heile poenget.
 * Trykk på parametrane for å bla mellom grovkorningar: 5x5, 13x13, og 4 nivå i staden for 16.
 * Kartet lagrar alltid bit/4, uavhengig av grovkorning, så talet på HUD-en er alltid bit.
 */
interface Preset {
	/** halv sidekant: vindauget er (2r+1)² piksel */
	r: number;
	/** talet på lysnivå, maks 16 (fire vec4-teljarar) */
	bins: number;
}
const PRESETS: Preset[] = [
	{ r: 4, bins: 16 },
	{ r: 2, bins: 16 },
	{ r: 4, bins: 4 },
	{ r: 6, bins: 16 }
];
const HFIX = 4; // kartet lagrar bit/4 (log2 16)

const FS_H = `
uniform sampler2D uFrame;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uMix;
uniform int uR;
uniform float uBins;
uniform float uInv;
void main() {
	vec4 a = vec4(0.0), b = vec4(0.0), c = vec4(0.0), d = vec4(0.0);
	for (int j = -uR; j <= uR; j++) {
		for (int i = -uR; i <= uR; i++) {
			float l = texture(uFrame, vUv + vec2(float(i), float(j)) * uTexel).a;
			vec4 q = vec4(min(floor(l * uBins), uBins - 1.0));
			a += vec4(equal(q, vec4(0.0, 1.0, 2.0, 3.0)));
			b += vec4(equal(q, vec4(4.0, 5.0, 6.0, 7.0)));
			c += vec4(equal(q, vec4(8.0, 9.0, 10.0, 11.0)));
			d += vec4(equal(q, vec4(12.0, 13.0, 14.0, 15.0)));
		}
	}
	a *= uInv; b *= uInv; c *= uInv; d *= uInv;
	float h = 0.0;
	h -= dot(a, log2(max(a, vec4(1e-6))));
	h -= dot(b, log2(max(b, vec4(1e-6))));
	h -= dot(c, log2(max(c, vec4(1e-6))));
	h -= dot(d, log2(max(d, vec4(1e-6))));
	float prev = texture(uPrev, vUv).r;
	o = vec4(mix(h / ${HFIX}.0, prev, uMix), 0.0, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}${RAMPS}
uniform sampler2D uMap;
uniform float uHmax;
void main() {
	float h = texture(uMap, vUv).r * ${HFIX}.0 / uHmax;
	float hs = textureLod(uMap, vUv, 1.0).r;
	float L = dot(camera(vUv), vec3(0.2126, 0.7152, 0.0722));
	float v = smoothstep(0.08, 0.80, h);
	vec3 col = vec3(L) * 0.16 * (1.0 - v) + rampCool(v);
	// koter for kvar heile bit
	float bits = hs * ${HFIX}.0;
	float dd = abs(bits - floor(bits + 0.5));
	float w = max(fwidth(bits) * 1.4, 1e-4);
	float line = (1.0 - smoothstep(0.0, w, dd)) * step(0.7, bits) * step(bits, uHmax - 0.3);
	col = mix(col, vec3(1.0), line * 0.65);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Rom implements Setup {
	readonly info: SetupInfo = {
		id: 'rom',
		code: 'ROM',
		name: 'Rom',
		blurb: 'Lokal entropi. Kor uordna er kvar flekk: 9×9 piksel, 16 nivå.',
		how: 'Peik mot noko flatt og noko rotete. Trykk på talet nede til høgre for anna grovkorning.',
		needsFloat: true,
		probe: true
	};

	private hProg!: Prog;
	private dProg!: Prog;
	private map: Target[] = [];
	private mi = 0;
	private pi = 0;
	private meter!: MapMeter;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.hProg = g.prog('rom.h', FS_H);
		this.dProg = g.prog('rom.draw', FS_DRAW);
		this.map = [g.target(ctx.w, ctx.h, g.F16, true, true), g.target(ctx.w, ctx.h, g.F16, true, true)];
		this.meter = new MapMeter(g);
	}

	private get pre() {
		return PRESETS[this.pi];
	}

	cycle(): string {
		this.pi = (this.pi + 1) % PRESETS.length;
		this.eG.reset();
		this.eS.reset();
		const { r, bins } = this.pre;
		const n = 2 * r + 1;
		return `${n}×${n} piksel, ${bins} nivå, maks ${Math.log2(bins)} bit. Same bilete, anna entropi.`;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { r, bins } = this.pre;
		const out = this.map[this.mi];
		const prev = this.map[1 - this.mi];
		g.to(out);
		g.use(this.hProg);
		g.sampler(this.hProg, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.hProg, 'uPrev', 1, prev.tex);
		gl.uniform2f(this.hProg.u('uTexel'), 1 / ctx.w, 1 / ctx.h);
		gl.uniform1f(this.hProg.u('uMix'), 0.45);
		gl.uniform1i(this.hProg.u('uR'), r);
		gl.uniform1f(this.hProg.u('uBins'), bins);
		gl.uniform1f(this.hProg.u('uInv'), 1 / ((2 * r + 1) * (2 * r + 1)));
		g.quad();
		// punktmåling: ~14 % av breidda
		this.meter.run(ctx, out, 0, 0);
		this.mi ^= 1;
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const map = this.map[1 - this.mi]; // sist skrive
		g.use(this.dProg);
		g.sampler(this.dProg, 'uMap', 0, map.tex);
		g.sampler(this.dProg, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dProg.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.dProg.u('uHmax'), Math.log2(this.pre.bins));
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const { r, bins } = this.pre;
		const hmax = Math.log2(bins);
		const gl = this.eG.step(m.globalA * HFIX);
		const sp = this.eS.step(m.spotA * HFIX);
		return {
			gauge: clamp01(gl / hmax),
			ruler: clamp01(sp / hmax),
			value: gl.toFixed(2),
			chip: 'BIT',
			params: `${2 * r + 1}x${2 * r + 1} ${bins}B`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.map.forEach((t) => t.del());
		this.meter?.dispose();
	}
}
