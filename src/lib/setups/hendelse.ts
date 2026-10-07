import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, RAMPS, clamp01 } from './common';

/**
 * Hending. Eit kamera som berre ser endring.
 *
 * Ei emulering av eit hendingskamera (DVS, Lichtsteiner 2008): kvar piksel hugsar eit referansenivå i
 * log-lys, L = ln(1 + lys/16), og tiger heilt til lyset har endra seg med ein terskel θ. Då sender han ei
 * melding, ON viss det vart lysare og OFF viss det vart mørkare, og set referansen opp eller ned ein terskel.
 * Eit stille bilete gir ingen meldingar. Dette er delta-modulasjon: berre det nye vert sendt.
 *
 * Talet er bitraten til meldingane. Per bilete er kvar piksel ON, OFF eller ingenting, og vi reknar
 * entropien til det kartet som om pikslane var uavhengige: H = −Σ p·log2(p). Det er ei øvre grense, sidan
 * meldingane i røynda heng saman i rom. Rate = H · piksel · 30 bilete/s. Same oppløysing som vanleg video
 * (8 bit per piksel) er 45 500 kb/s.
 */
const RAW_KBPS = (8 * 296 * 640 * 30) / 1000;
const THS = [0.18, 0.1, 0.35, 0.05];

const FS_UPDATE = `
uniform sampler2D uFrame;
uniform sampler2D uState;
uniform float uTh;
uniform float uDecay;
uniform float uLive;
void main() {
	float l = log(1.0 + texture(uFrame, vUv).a * 255.0 / 16.0);
	vec3 s = texture(uState, vUv).rgb;
	float d = l - s.x;
	float n = floor(abs(d) / uTh) * uLive;
	float lr = uLive > 0.5 ? s.x + sign(d) * n * uTh : l;
	float on = (d > 0.0 && n > 0.5) ? 1.0 : 0.0;
	float off = (d < 0.0 && n > 0.5) ? 1.0 : 0.0;
	o = vec4(lr, max(s.y * uDecay, on), max(s.z * uDecay, off), 1.0);
}`;

const FS_MAP = `
uniform sampler2D uState;
void main() {
	vec3 s = texture(uState, vUv).rgb;
	o = vec4(step(0.999, s.y), step(0.999, s.z), 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}${RAMPS}
uniform sampler2D uState;
void main() {
	vec3 s = texture(uState, vUv).rgb;
	float L = dot(camera(vUv), vec3(0.2126, 0.7152, 0.0722));
	vec3 col = vec3(L) * 0.10;
	float e1 = s.y * s.y;
	float e2 = s.z * s.z;
	col += mix(vec3(1.0, 0.5, 0.14), vec3(1.0, 0.96, 0.86), smoothstep(0.55, 1.0, s.y)) * e1;
	col += mix(vec3(0.10, 0.36, 0.95), vec3(0.72, 0.90, 1.0), smoothstep(0.55, 1.0, s.z)) * e2;
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

const xlog = (p: number) => (p > 1e-12 ? p * Math.log2(p) : 0);

export class Hendelse implements Setup {
	readonly info: SetupInfo = {
		id: 'hending',
		code: 'HEN',
		group: 'tid',
		name: 'Hending',
		blurb: 'Eit kamera som berre ser endring. Kvar piksel tiger til lyset endrar seg.',
		how: 'Hald stille: det tiger. Veiv handa: meldingane kjem. Talet er kva dei kostar i bit.',
		needsFloat: true,
		probe: true,
		still: true
	};

	private uP!: Prog;
	private mP!: Prog;
	private dP!: Prog;
	private st: Target[] = [];
	private si = 0;
	private map!: Target;
	private meter!: MapMeter;
	private th = 0;
	private eR = new Ease();
	private eP = new Ease();
	private px = 296 * 640;

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.uP = g.prog('hen.update', FS_UPDATE);
		this.mP = g.prog('hen.map', FS_MAP);
		this.dP = g.prog('hen.draw', FS_DRAW);
		const f = g.floatFmt();
		this.st = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.px = ctx.w * ctx.h;
		for (const t of this.st) {
			g.to(t);
			g.gl.clearColor(0, 0, 0, 1);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
	}

	cycle(): string {
		this.th = (this.th + 1) % THS.length;
		this.eR.reset();
		this.eP.reset();
		return `Terskel ${Math.round(THS[this.th] * 100)} % endring i lys. Mindre enn det ser kameraet ikkje.`;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const out = this.st[1 - this.si];
		g.to(out);
		g.use(this.uP);
		g.sampler(this.uP, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.uP, 'uState', 1, this.st[this.si].tex);
		gl.uniform1f(this.uP.u('uTh'), THS[this.th]);
		gl.uniform1f(this.uP.u('uDecay'), 0.82);
		gl.uniform1f(this.uP.u('uLive'), ctx.frameNo < 1 ? 0 : 1);
		g.quad();
		this.si ^= 1;

		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uState', 0, this.st[this.si].tex);
		g.quad();
		this.meter.run(ctx, this.map, 0, 1);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uState', 0, this.st[this.si].tex);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const pOn = m.globalA;
		const pOff = m.globalB;
		const p0 = Math.max(0, 1 - pOn - pOff);
		const bitsPerPx = -(xlog(p0) + xlog(pOn) + xlog(pOff));
		const rate = this.eR.step((bitsPerPx * this.px * 30) / 1000, 0.3);
		const sOn = m.spotA;
		const sOff = m.spotB;
		const pol = this.eP.step(sOn + sOff > 1e-4 ? sOn / (sOn + sOff) : 0.5, 0.25);
		return {
			gauge: clamp01(Math.log10(Math.max(rate, 1)) / Math.log10(RAW_KBPS)),
			ruler: clamp01(pol),
			value: rate >= 100 ? rate.toFixed(0) : rate.toFixed(1),
			chip: 'KB/S',
			params: `T${Math.round(THS[this.th] * 100)}%`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.st.forEach((t) => t.del());
		this.map?.del();
		this.meter?.dispose();
	}
}
