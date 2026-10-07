import type { Prog } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, clamp01 } from './common';

/**
 * Søkjar. Rein kamerabilete, og det einaste som er målt er det klassiske:
 * Shannon-entropien til lysnivåa i heile biletet, H = -Σ p·log2 p over 64 nivå (maks 6 bit).
 * Ein svart vegg og eit kaotisk grusfelt har same snittlys, men ulik H.
 * Linjalen er ein vanleg lysmålar på sonden.
 */
const BINS = 64;

const FS = `${COVER_VIDEO}
void main() {
	vec3 c = camera(vUv);
	// svak mørkning øvst og nedst så kvit HUD alltid les
	float top = smoothstep(0.80, 1.0, vUv.y);
	float bot = smoothstep(0.22, 0.0, vUv.y);
	c *= 1.0 - 0.42 * top - 0.50 * bot;
	o = vec4(c, 1.0);
}`;

export class Soker implements Setup {
	readonly info: SetupInfo = {
		id: 'soker',
		code: 'SØK',
		name: 'Søkjar',
		blurb: 'Rein søkjar. Tal: entropien til lysnivåa i heile biletet.',
		needsFloat: false,
		probe: true
	};

	private prog!: Prog;
	private H = 0;
	private spot = 0.5;
	private last = -1e9;
	private eH = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		this.prog = ctx.gfx.prog('soker.draw', FS);
	}

	frame(ctx: Ctx) {
		if (ctx.now - this.last < 200) return;
		const w = ctx.w;
		const h = ctx.h;
		const px = Math.round(ctx.probe[0] * (w - 1));
		const py = Math.round(ctx.probe[1] * (h - 1));
		const ok = ctx.read(ctx.cur, 0, 0, w, h, (b) => {
			const hist = new Uint32Array(BINS);
			const n = w * h;
			for (let i = 0; i < n; i++) hist[b[i * 4 + 3] >> 2]++;
			let H = 0;
			for (let k = 0; k < BINS; k++) {
				if (hist[k]) {
					const p = hist[k] / n;
					H -= p * Math.log2(p);
				}
			}
			this.H = H;
			// punktmåling: snitt av 13x13 piksel rundt sonden
			let s = 0;
			let c = 0;
			for (let y = Math.max(0, py - 6); y <= Math.min(h - 1, py + 6); y++) {
				for (let x = Math.max(0, px - 6); x <= Math.min(w - 1, px + 6); x++) {
					s += b[(y * w + x) * 4 + 3];
					c++;
				}
			}
			this.spot = s / c / 255;
		});
		if (ok) this.last = ctx.now;
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.prog);
		g.sampler(this.prog, 'uVideo', 0, ctx.video);
		gl.uniform2f(this.prog.u('uCover'), ctx.cover[0], ctx.cover[1]);
		g.quad();
	}

	meters(): Meters {
		const H = this.eH.step(this.H);
		return {
			gauge: clamp01(H / Math.log2(BINS)),
			ruler: clamp01(this.eS.step(this.spot)),
			value: H.toFixed(2),
			chip: 'BIT',
			params: `${BINS}B`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {}
}
