import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, Ease, MapMeter, clamp01 } from './common';

/**
 * Bølgje. Ei dam der tida kan gå baklengs.
 *
 * Overflata følgjer bølgjelikninga, u_tt = c²·∇²u, rekna ut med eit sprangsteg (leapfrog) på ein ruter av piksel.
 * Det som rører seg framfor kameraet, og fingeren din, dyttar vatnet. Ringane breier seg og vert refleksjonar:
 * energien vert spreidd utover heile dammen. Etter nokre sekund er det ikkje råd å sjå kvar han kom frå.
 *
 * Men likninga kjenner ikkje framover frå bakover. Steget kan kjørast attende nøyaktig, og kvart dytt vert trekt
 * frå att med same styrke som det vart gitt: x_t = F⁻¹(x_(t+1)) − s_t. Trykk, og dammen kjører sin eigen film
 * baklengs. Ringane trekkjer seg saman i handa som laga dei, og vatnet vert flatt som før du rørte det.
 * Dette er Loschmidts innvending mot Boltzmann (1876): lovene tillèt det, men ingen kan snu kvart einaste
 * molekyl. Her kan du det, fordi dammen berre har 190 000 frie tal og ei likning utan tap av informasjon.
 *
 * Talet er Boltzmann-entropien til energispreiinga: S = log2(talet på 8×8-ruter som har energi). Det er ein
 * grov makrotilstand der berre «kvar er det bølgjer» tel. Han går opp medan ringane breier seg og ned når
 * tida går baklengs, heilt til det er flatt.
 *
 * Eit lite tap (ε, ringane døyr ut over nokre sekund) held dammen frå å fyllast med støy. Baklengs er tapet
 * negativt, så ringane veks att mot sin eigen styrke. Dei siste 8 sekunda er lagra (ring av dytt), lenger attende
 * går det ikkje, då snur tida av seg sjølv.
 *
 * Tilstanden er (u_t, u_(t−1)) i flyttal med 32 bit, så snuinga er nøyaktig til avrundinga. Kameraet går
 * framover heile tida, berre vatnet snur.
 */
const CELL = 8;
/** energigrensa for at ei rute tel som «med bølgjer», i skalert energi */
const THETA = 0.03;
/** skalering så energien held seg i 16-bits flyttal */
const ESCALE = 1024;
/** tal på bilete med dytt vi hugsar, 8 s */
const K = 240;

interface Preset {
	label: string;
	note: string;
	/** c², under 0.5 for stabilitet */
	c2: number;
	/** demping per delsteg */
	eps: number;
	steps: number;
	/** kor sterkt rørsle i biletet dyttar */
	mot: number;
	/** kor sterkt fingeren dyttar */
	touch: number;
}

const PRESETS: Preset[] = [
	{
		label: 'DAM',
		note: 'Ei dam. Det som rører seg dyttar vatnet, og fingeren òg.',
		c2: 0.4,
		eps: 0.0012,
		steps: 4,
		mot: 0.05,
		touch: 0.5
	},
	{
		label: 'STILL',
		note: 'Nesten utan demping. Ringane lever lenge og vert til eit bølgjemønster.',
		c2: 0.25,
		eps: 0.0003,
		steps: 3,
		mot: 0.04,
		touch: 0.4
	},
	{
		label: 'HAV',
		note: 'Kraftigare. Små rørsler gir store bølgjer.',
		c2: 0.45,
		eps: 0.0025,
		steps: 5,
		mot: 0.14,
		touch: 0.8
	},
	{
		label: 'TJERN',
		note: 'Berre fingeren dyttar. Biletet rører ikkje vatnet.',
		c2: 0.4,
		eps: 0.0012,
		steps: 4,
		mot: 0,
		touch: 0.6
	}
];

const FS_STEP = `
uniform sampler2D uS;
uniform ivec2 uSize;
uniform float uC2;
uniform float uEps;
uniform int uDir;
vec2 S(ivec2 p) { return texelFetch(uS, clamp(p, ivec2(0), uSize - ivec2(1)), 0).rg; }
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	vec2 s = S(p);
	vec2 r = S(p + ivec2(1, 0));
	vec2 l = S(p - ivec2(1, 0));
	vec2 u = S(p + ivec2(0, 1));
	vec2 d = S(p - ivec2(0, 1));
	if (uDir > 0) {
		float lap = r.x + l.x + u.x + d.x - 4.0 * s.x;
		float n = (2.0 * s.x - (1.0 - uEps) * s.y + uC2 * lap) / (1.0 + uEps);
		o = vec4(n, s.x, 0.0, 0.0);
	} else {
		float lap = r.y + l.y + u.y + d.y - 4.0 * s.y;
		float n = (2.0 * s.y + uC2 * lap - (1.0 + uEps) * s.x) / (1.0 - uEps);
		o = vec4(s.y, n, 0.0, 0.0);
	}
}`;

/** Rørsle: kor mykje lyset skifta, i 8×8-snitt, så dyttet er glatt. Vert lagra per bilete (8 bit). */
const FS_MOT = `
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform float uZero;
void main() {
	vec2 px = 1.0 / vec2(textureSize(uCur, 0));
	float acc = 0.0;
	for (int j = 0; j < 8; j++) {
		for (int i = 0; i < 8; i++) {
			vec2 uv = vUv + (vec2(float(i), float(j)) - 3.5) * px;
			acc += abs(texture(uCur, uv).a - texture(uPrev, uv).a);
		}
	}
	acc /= 64.0;
	o = vec4(smoothstep(0.03, 0.12, acc) * (1.0 - uZero), 0.0, 0.0, 1.0);
}`;

/** Dytt (sign +1) eller trekk att same dytt (sign −1). Same lagra rørsle og same fingerbule begge vegar. */
const FS_INJ = `
uniform sampler2D uS;
uniform sampler2DArray uH;
uniform int uLayer;
uniform float uSign;
uniform float uMot;
uniform vec2 uT;
uniform float uTAmp;
uniform float uTR;
uniform float uAsp;
void main() {
	vec2 s = texelFetch(uS, ivec2(gl_FragCoord.xy), 0).rg;
	float inj = 0.0;
	if (uMot > 0.0) inj += uMot * texture(uH, vec3(vUv, float(uLayer))).r;
	if (uTAmp > 0.0) {
		vec2 d = (vUv - uT) * vec2(uAsp, 1.0);
		inj += uTAmp * exp(-dot(d, d) / (uTR * uTR));
	}
	o = vec4(s + vec2(uSign * inj), 0.0, 0.0);
}`;

const FS_DISP = `
uniform sampler2D uS;
uniform ivec2 uSize;
uniform float uC2;
float U(ivec2 p) { return texelFetch(uS, clamp(p, ivec2(0), uSize - ivec2(1)), 0).r; }
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	vec2 s = texelFetch(uS, p, 0).rg;
	float gx = 0.5 * (U(p + ivec2(1, 0)) - U(p - ivec2(1, 0)));
	float gy = 0.5 * (U(p + ivec2(0, 1)) - U(p - ivec2(0, 1)));
	float v = s.x - s.y;
	float e = v * v + uC2 * (gx * gx + gy * gy);
	o = vec4(s.x, gx, gy, e * ${ESCALE}.0);
}`;

const FS_OCC = `
uniform sampler2D uD;
void main() {
	float e = textureLod(uD, vUv, 3.0).a;
	float occ = e / (e + ${THETA});
	o = vec4(occ, 0.0, 0.0, 1.0);
}`;

const FS_DRAW = `${COVER_VIDEO}
uniform sampler2D uD;
uniform float uRev;
void main() {
	vec4 d = texture(uD, vUv);
	vec2 g = d.yz;
	vec3 cam = camera(vUv + g * 0.5);
	vec3 n = normalize(vec3(-g * 45.0, 1.0));
	vec3 h = normalize(normalize(vec3(-0.45, 0.55, 0.7)) + vec3(0.0, 0.0, 1.0));
	float spec = pow(max(dot(n, h), 0.0), 70.0);
	float shade = clamp(n.z, 0.0, 1.0);
	vec3 tint = mix(vec3(0.90, 0.97, 1.06), vec3(1.10, 0.96, 0.82), uRev);
	vec3 col = cam * tint * (0.62 + 0.38 * shade) + vec3(spec) * mix(vec3(0.85, 0.95, 1.0), vec3(1.0, 0.88, 0.7), uRev);
	col += tint * 0.5 * clamp(d.x, -0.4, 0.4) * 0.35;
	col += tint * 0.34 * clamp((length(g) * 26.0 - 0.12) / 0.88, 0.0, 1.0);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

interface Rec {
	x: number;
	y: number;
	a: number;
}

export class Bolgje implements Setup {
	readonly info: SetupInfo = {
		id: 'bolgje',
		code: 'BØL',
		group: 'dyn',
		name: 'Bølgje',
		blurb: 'Ei dam som du dyttar på med handa. Trykk: tida går baklengs, og dammen vert flat att.',
		how: 'Veiv med handa eller hald fingeren nede. Trykk ein gong for å snu tida, igjen for å gå vidare.',
		needsFloat: true,
		probe: false,
		press: true,
		still: true
	};

	private gl!: WebGL2RenderingContext;
	private sP!: Prog;
	private iP!: Prog;
	private qP!: Prog;
	private dP!: Prog;
	private oP!: Prog;
	private wP!: Prog;
	private st: Target[] = [];
	private si = 0;
	private hist: WebGLTexture | null = null;
	private histFbo: WebGLFramebuffer | null = null;
	private qw = 8;
	private qh = 8;
	private rec: Rec[] = Array.from({ length: K }, () => ({ x: 0.5, y: 0.5, a: 0 }));
	private disp!: Target;
	private occ!: Target;
	private meter!: MapMeter;
	private pr = 0;
	private dir: 1 | -1 = 1;
	/** tid framover frå start, i bilete. Går ned når tida går baklengs. */
	private net = 0;
	/** eldste biletet vi framleis har dyttet til */
	private floor = 0;
	private down = false;
	private downAt = 0;
	private tx = 0.5;
	private ty = 0.5;
	private eS = new Ease();
	private nCells = 1;

	init(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		this.gl = gl;
		this.sP = g.prog('bol.step', FS_STEP);
		this.iP = g.prog('bol.inj', FS_INJ);
		this.qP = g.prog('bol.mot', FS_MOT);
		this.dP = g.prog('bol.disp', FS_DISP);
		this.oP = g.prog('bol.occ', FS_OCC);
		this.wP = g.prog('bol.draw', FS_DRAW);
		const f = g.floatFmt();
		this.st = [g.target(ctx.w, ctx.h, f, false), g.target(ctx.w, ctx.h, f, false)];
		this.disp = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.occ = g.target(ctx.w, ctx.h, g.F16, true, true);
		this.meter = new MapMeter(g);
		this.nCells = (ctx.w / CELL) * (ctx.h / CELL);

		this.qw = Math.max(8, ctx.w >> 3);
		this.qh = Math.max(8, ctx.h >> 3);
		this.hist = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
		gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.qw, this.qh, K);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.histFbo = gl.createFramebuffer();
		this.clear(ctx);
	}

	private clear(ctx: Ctx) {
		const g = ctx.gfx;
		for (const t of this.st) {
			g.to(t);
			g.gl.clearColor(0, 0, 0, 0);
			g.gl.clear(g.gl.COLOR_BUFFER_BIT);
		}
		this.net = 0;
		this.floor = 0;
		this.dir = 1;
		this.eS.reset();
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	/** Trykk: snu tida. Går ikkje utan noko å gå attende til. */
	tap(): boolean {
		if (this.dir > 0) {
			if (this.net > this.floor) this.dir = -1;
		} else {
			this.dir = 1;
		}
		return true;
	}

	touch(ctx: Ctx, x: number, y: number, down: boolean) {
		if (down && !this.down) this.downAt = ctx.now;
		this.down = down;
		if (down) {
			this.tx = x;
			this.ty = y;
		}
	}

	cycle(ctx: Ctx): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.clear(ctx);
		return this.pre.note;
	}

	private writeMask(ctx: Ctx, layer: number) {
		const g = ctx.gfx;
		const gl = g.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo);
		gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.hist, 0, layer);
		gl.viewport(0, 0, this.qw, this.qh);
		g.use(this.qP);
		g.sampler(this.qP, 'uCur', 0, ctx.cur.tex);
		g.sampler(this.qP, 'uPrev', 1, ctx.prev.tex);
		gl.uniform1f(this.qP.u('uZero'), ctx.frameNo < 2 ? 1 : 0);
		g.quad();
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	private inject(ctx: Ctx, layer: number, sign: 1 | -1) {
		const g = ctx.gfx;
		const gl = g.gl;
		const p = this.pre;
		const r = this.rec[layer];
		if (p.mot <= 0 && r.a <= 0) return;
		g.to(this.st[1 - this.si]);
		g.use(this.iP);
		g.sampler(this.iP, 'uS', 0, this.st[this.si].tex);
		g.sampler(this.iP, 'uH', 1, this.hist, gl.TEXTURE_2D_ARRAY);
		gl.uniform1i(this.iP.u('uLayer'), layer);
		gl.uniform1f(this.iP.u('uSign'), sign);
		gl.uniform1f(this.iP.u('uMot'), p.mot);
		gl.uniform2f(this.iP.u('uT'), r.x, r.y);
		gl.uniform1f(this.iP.u('uTAmp'), r.a);
		gl.uniform1f(this.iP.u('uTR'), 0.011);
		gl.uniform1f(this.iP.u('uAsp'), ctx.w / ctx.h);
		g.quad();
		this.si ^= 1;
	}

	private run(ctx: Ctx, dir: 1 | -1) {
		const g = ctx.gfx;
		const gl = g.gl;
		const p = this.pre;
		for (let k = 0; k < p.steps; k++) {
			g.to(this.st[1 - this.si]);
			g.use(this.sP);
			g.sampler(this.sP, 'uS', 0, this.st[this.si].tex);
			gl.uniform2i(this.sP.u('uSize'), ctx.w, ctx.h);
			gl.uniform1f(this.sP.u('uC2'), p.c2);
			gl.uniform1f(this.sP.u('uEps'), p.eps);
			gl.uniform1i(this.sP.u('uDir'), dir);
			g.quad();
			this.si ^= 1;
		}
	}

	frame(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		const p = this.pre;

		if (this.dir > 0) {
			// framover: lagra dyttet, legg det til, så sprangsteg
			const layer = this.net % K;
			const touching = this.down && ctx.now - this.downAt > 140;
			this.rec[layer] = { x: this.tx, y: this.ty, a: touching ? p.touch : 0 };
			if (p.mot > 0) this.writeMask(ctx, layer);
			this.inject(ctx, layer, 1);
			this.run(ctx, 1);
			this.net++;
			this.floor = Math.max(this.floor, this.net - K);
		} else {
			// baklengs: sprangsteg attende, så trekk frå dyttet som vart gitt i det biletet
			this.run(ctx, -1);
			this.net--;
			this.inject(ctx, this.net % K, -1);
			if (this.net <= this.floor) this.dir = 1;
		}

		// høgd, helling og energi, og teljinga av ruter med energi
		g.to(this.disp);
		g.use(this.dP);
		g.sampler(this.dP, 'uS', 0, this.st[this.si].tex);
		gl.uniform2i(this.dP.u('uSize'), ctx.w, ctx.h);
		gl.uniform1f(this.dP.u('uC2'), p.c2);
		g.quad();
		g.mipmap(this.disp);

		g.to(this.occ);
		g.use(this.oP);
		g.sampler(this.oP, 'uD', 0, this.disp.tex);
		g.quad();
		this.meter.run(ctx, this.occ, 0, 0);
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.wP);
		g.sampler(this.wP, 'uD', 0, this.disp.tex);
		g.sampler(this.wP, 'uVideo', 1, ctx.video);
		gl.uniform2f(this.wP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1f(this.wP.u('uRev'), this.dir < 0 ? 1 : 0);
		g.quad();
	}

	meters(): Meters {
		const n = Math.max(1, this.meter.globalA * this.nCells);
		const S = this.eS.step(Math.log2(n), 0.25);
		const secs = Math.max(0, this.net) / 30;
		return {
			gauge: clamp01(S / Math.log2(this.nCells)),
			ruler: clamp01(this.net / 900),
			value: S.toFixed(1),
			chip: 'BIT',
			params: `${this.pre.label} ${this.dir > 0 ? 'FRAM' : 'BAK'} ${secs.toFixed(1)}`,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.st.forEach((t) => t.del());
		this.disp?.del();
		this.occ?.del();
		this.meter?.dispose();
		if (this.hist) this.gl?.deleteTexture(this.hist);
		if (this.histFbo) this.gl?.deleteFramebuffer(this.histFbo);
		this.hist = null;
		this.histFbo = null;
	}
}
