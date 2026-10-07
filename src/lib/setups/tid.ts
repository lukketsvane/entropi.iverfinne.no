import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, RAMPS, clamp01 } from './common';

/**
 * Tid. Kor mykje nytt kjem inn per bilete?
 * Kvar piksel vert «koda» mot det førre biletet (DPCM). Det som er att, d = x − x_førre, er nyheita.
 * Informasjonen i d under ei fast støymodell med spreiing σ0 er ½·log2(1 + (d/σ0)²) bit.
 * Ein stille scene gir rundt null (berre sensorstøy), jamn panorering og skjelving gir mykje.
 * Etterglød (ein glidande topp som døyr ut) viser kvar det nett skjedde noko.
 * Merk: dette er entropien til endringa, ikkje til sjølve biletet. Det er ei anna grovkorning enn Rom.
 * Trykk på parametrane for å flytte støygolvet σ: ein høgare σ gjer at berre store endringar tel som nytt.
 */
/** Støynivået modellen reknar som «ingenting», i gråtrinn. Trykk på parametrane for å bla: 3 er standard. */
const SIGS = [3, 6, 12, 1.5];
const MAXB = 8;

const FS_UPDATE = `
uniform sampler2D uFrame;
uniform sampler2D uPrevF;
uniform sampler2D uState;
uniform float uSig;
uniform float uDecay;
uniform float uLive;
void main() {
	float x = texture(uFrame, vUv).a * 255.0;
	float xp = texture(uPrevF, vUv).a * 255.0;
	float z = (x - xp) / uSig;
	float bits = 0.5 * log2(1.0 + z * z) * uLive;
	float b = min(bits / ${MAXB}.0, 1.0);
	float glow = max(b, texture(uState, vUv).b * uDecay);
	o = vec4(0.0, 0.0, glow, b);
}`;

const FS_DRAW = `${COVER_VIDEO}${RAMPS}
uniform sampler2D uState;
void main() {
	float g = texture(uState, vUv).b;
	float L = dot(camera(vUv), vec3(0.2126, 0.7152, 0.0722));
	float v = 1.0 - exp(-g * 4.5);
	vec3 col = vec3(L) * 0.13 * (1.0 - v) + rampWarm(v);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Tid implements Setup {
	readonly info: SetupInfo = {
		id: 'tid',
		code: 'TID',
		name: 'Tid',
		blurb: 'Nyheit. Kor mykje nytt kjem inn per bilete, i bit per piksel.',
		needsFloat: true,
		probe: true
	};

	private uProg!: Prog;
	private dProg!: Prog;
	private st: Target[] = [];
	private si = 0;
	private sg = 0;
	private meter!: MapMeter;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.uProg = g.prog('tid.update', FS_UPDATE);
		this.dProg = g.prog('tid.draw', FS_DRAW);
		this.st = [g.target(ctx.w, ctx.h, g.F16, true, true), g.target(ctx.w, ctx.h, g.F16, true, true)];
		this.meter = new MapMeter(g);
		for (const t of this.st) {
			g.to(t);
			g.gl.clearColor(0, 0, 0, 0);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
	}

	private get sigma() {
		return SIGS[this.sg];
	}

	cycle(): string {
		this.sg = (this.sg + 1) % SIGS.length;
		this.eG.reset();
		this.eS.reset();
		const s = this.sigma;
		return `Støygolv σ = ${s} gråtrinn. Mindre enn det tel som ingenting.`;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const out = this.st[this.si];
		const prev = this.st[1 - this.si];
		g.to(out);
		g.use(this.uProg);
		g.sampler(this.uProg, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.uProg, 'uPrevF', 1, ctx.prev.tex);
		g.sampler(this.uProg, 'uState', 2, prev.tex);
		gl.uniform1f(this.uProg.u('uSig'), this.sigma);
		gl.uniform1f(this.uProg.u('uDecay'), 0.84);
		// første bileta har ingen forgjengar
		gl.uniform1f(this.uProg.u('uLive'), ctx.frameNo < 2 ? 0 : 1);
		g.quad();
		// A = rå innovasjon (kanal a), B = etterglød (kanal b)
		this.meter.run(ctx, out, 3, 2);
		this.si ^= 1;
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const s = this.st[1 - this.si];
		g.use(this.dProg);
		g.sampler(this.dProg, 'uState', 0, s.tex);
		g.sampler(this.dProg, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dProg.u('uCover'), ctx.cover[0], ctx.cover[1]);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const mean = m.globalA * MAXB;
		const spot = m.spotA * MAXB;
		const gm = this.eG.step(mean, 0.3);
		const sp = this.eS.step(spot, 0.3);
		return {
			gauge: clamp01(gm / 2.5),
			ruler: clamp01(sp / 4),
			value: gm.toFixed(2),
			chip: 'BIT',
			params: `1/30 S${this.sigma}`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.st.forEach((t) => t.del());
		this.meter?.dispose();
	}
}
