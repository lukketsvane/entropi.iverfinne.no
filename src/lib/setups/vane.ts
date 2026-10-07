import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Vane. Eit kamera som vert lei.
 *
 * Kvar piksel lærer kva som er normalt: eit glidande snitt μ og ein varians σ² av fargen, med tidskonstant τ.
 * Det nye bilete vert målt mot det kameraet venta. Overrasking i bit er ½·log2(1 + z²), z = (x − μ)/σ,
 * den same logaritmen som i Tid, men σ er lært per piksel i staden for fast: ei tre som blafrar vert
 * ikkje overraskande, ei hand som kjem inn vert det. Berre det som er overraskande vert vist, i sine eigne
 * fargar. Det som blir verande vert vant til, og forsvinn etter nokre τ: Troxler-fading, i eit kamera.
 *
 * Variansen lærer seg ikkje av hendingane: kvadratavviket vert kutta ved 9σ² før det går inn, så ei plutseleg
 * hending ikkje med ein gong gjer seg sjølv uinteressant. Vanen kjem av at μ tek att biletet, over tid.
 *
 * Gjennomsnittleg overrasking per piksel er det som vert vist: entropirate-aktig, men over eit lært bilete
 * som aldri er heilt rett. Sensorstøy under σ₀ = 2.5 gråtrinn tel som ingenting.
 */
const TAUS = [30, 8, 120, 480];
const S0 = 2.5;
const BMAX = 6;

const FS_MAP = `
uniform sampler2D uFrame;
uniform sampler2D uState;
uniform float uS0;
void main() {
	vec3 x = texture(uFrame, vUv).rgb * 255.0;
	vec4 s = texture(uState, vUv);
	vec3 r = x - s.rgb;
	float sig2 = max(s.a, uS0 * uS0);
	float z2 = dot(r, r) / (3.0 * sig2);
	float bits = 0.5 * log2(1.0 + z2);
	o = vec4(min(bits / ${BMAX}.0, 1.0), 0.0, 0.0, 1.0);
}`;

const FS_UPDATE = `
uniform sampler2D uFrame;
uniform sampler2D uState;
uniform float uS0;
uniform float uA;
void main() {
	vec3 x = texture(uFrame, vUv).rgb * 255.0;
	vec4 s = texture(uState, vUv);
	vec3 r = x - s.rgb;
	float sig2 = max(s.a, uS0 * uS0);
	float r2 = dot(r, r) / 3.0;
	float rc = min(r2, 9.0 * sig2);
	o = vec4(s.rgb + r * uA, s.a + uA * (rc - s.a));
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uMap;
void main() {
	float b = texture(uMap, vUv).r * ${BMAX}.0;
	float g = smoothstep(0.06, 1.0, b);
	vec3 c = camera(vUv);
	float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
	vec3 col = c * g + vec3(L) * 0.06;
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Vane implements Setup {
	readonly info: SetupInfo = {
		id: 'vane',
		code: 'VAN',
		name: 'Vane',
		blurb: 'Eit kamera som vert lei. Berre det som er nytt vert lyst opp.',
		how: 'Hald stille: verda forsvinn. Rør deg: du lyser. Det som blir verande vert vant til.',
		needsFloat: true,
		probe: true
	};

	private mP!: Prog;
	private uP!: Prog;
	private dP!: Prog;
	private st: Target[] = [];
	private si = 0;
	private map!: Target;
	private meter!: MapMeter;
	private ti = 0;
	private eG = new Ease();
	private eS = new Ease();

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.mP = g.prog('van.map', FS_MAP);
		this.uP = g.prog('van.update', FS_UPDATE);
		this.dP = g.prog('van.draw', FS_DRAW);
		const f = g.floatFmt();
		this.st = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.map = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		for (const t of this.st) {
			g.to(t);
			g.gl.clearColor(0, 0, 0, 0);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
	}

	private get tau() {
		return TAUS[this.ti];
	}

	cycle(): string {
		this.ti = (this.ti + 1) % TAUS.length;
		this.eG.reset();
		this.eS.reset();
		const s = this.tau / 30;
		return `Vane ${s < 1 ? s.toFixed(1) : s.toFixed(0)} s. Det som blir verande forsvinn etter omtrent ${(s * 3).toFixed(s < 1 ? 1 : 0)} s.`;
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const cur = this.st[this.si];
		const nxt = this.st[1 - this.si];

		// 1. overrasking mot det kameraet venta (gammal tilstand)
		g.to(this.map);
		g.use(this.mP);
		g.sampler(this.mP, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.mP, 'uState', 1, cur.tex);
		gl.uniform1f(this.mP.u('uS0'), S0);
		g.quad();

		// 2. lær: μ og σ²
		g.to(nxt);
		g.use(this.uP);
		g.sampler(this.uP, 'uFrame', 0, ctx.cur.tex);
		g.sampler(this.uP, 'uState', 1, cur.tex);
		gl.uniform1f(this.uP.u('uS0'), S0);
		gl.uniform1f(this.uP.u('uA'), 1 / this.tau);
		g.quad();
		this.si ^= 1;

		this.meter.run(ctx, this.map, 0, 0);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uMap', 0, this.map.tex);
		g.sampler(this.dP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.dP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		g.quad();
	}

	meters(): Meters {
		const m = this.meter;
		const gm = this.eG.step(m.globalA * BMAX, 0.3);
		const sp = this.eS.step(m.spotA * BMAX, 0.3);
		return {
			gauge: clamp01(gm / 1.2),
			ruler: clamp01(sp / 4),
			value: gm.toFixed(2),
			chip: 'BIT',
			params: `T${(this.tau / 30).toFixed(this.tau < 30 ? 1 : 0)}S`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.st.forEach((t) => t.del());
		this.map?.del();
		this.meter?.dispose();
	}
}
