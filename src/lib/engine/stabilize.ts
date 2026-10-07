import { Prog, type Gfx, type Target } from './gl';

/**
 * Digitalt stativ.
 *
 * Fleire oppstillingar (Marey, Vane, Tidsfarge, Puls, Open Shutter ...) går ut frå at kameraet står i ro. Ein
 * hand skjelv, og då flyttar heile verda seg nokre piksel. Her vert den flyttinga målt og trekt frå før
 * oppstillinga ser biletet. Ingen CPU, ingen tilbakelesing, ingen etterslep: alt skjer på GPU-en, same bilete.
 *
 * Metode: Lucas-Kanade på ein gråtone-versjon i halv arbeidsoppløysing. Vi leitar etter forskyvinga e som gjer at det
 * nye biletet T(x) ≈ R(x − e), der R er ein referanse som flyt sakte etter (glidande snitt av dei stabiliserte
 * bileta). Førsteordens: T − R = −e·∇R. Minste kvadrat gir normallikningane
 *
 *   [ΣwIx²   ΣwIxIy  −ΣwIx] [ex]   [−ΣwIxIt]
 *   [ΣwIxIy  ΣwIy²   −ΣwIy] [ey] = [−ΣwIyIt]
 *   [ΣwIx    ΣwIy    −Σw  ] [ c]   [−ΣwIt  ]
 *
 * der c er ein lysstyrkeforskyving (så skiftande eksponering ikkje dreg biletet). Summane er snitt over biletet
 * (mipmap nivå 3), og 3×3-systemet vert løyst i ein skuggar med 1×1 utdata. Vekta w er robust: ein piksel der
 * det implisitte avviket |It|/|∇R| er stort (ei hand som rører seg, eit tre i vind) tel mindre, så forskyvinga
 * følgjer det som dominerer, ofte bakgrunnen. To rundar per bilete, først på uskarpe gradientar (stor
 * rekkevidde), så på skarpe.
 *
 * Det som vert gitt vidare er ei ny videotekstur i full storleik, forskyvd med den målte forskyvinga. Forskyvinga
 * vert aldri berre lagt til: ho vert ein del av tilstanden, og om ho vert større enn 12 % av breidda startar
 * stativet på nytt (nytt referansebilete) i staden for å la biletet gli ut av ruta.
 *
 * Ei lita dødsone (0.015 piksel) hindrar at målestøy ristar eit kamera som alt står i ro.
 */
const SC = 16;
const LVL = 3;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
`;

const LUMA = `
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;

/** Arbeidsoppløysing, skift av førre tilstand: tw = lys i vising (view) etter at førre forskyving er trekt frå. */
const FS_PRE = `${HEAD}${LUMA}
out vec4 o;
uniform sampler2D uRaw;
uniform sampler2D uSt;
uniform vec2 uCover;
uniform vec2 uGrid;
void main() {
	vec2 s = texelFetch(uSt, ivec2(0), 0).xy;
	vec2 uv = vUv + s / uGrid;
	vec2 c = (uv - 0.5) * uCover + 0.5;
	o = vec4(lum(texture(uRaw, c).rgb), 0.0, 0.0, 1.0);
}`;

/** Kopi av forskyvinga (xy), utan flagg. Brukt både til startpunkt for runden og til å nullstille flagget. */
const FS_MARK = `${HEAD}
out vec4 o;
uniform sampler2D uSt;
void main() {
	vec4 s = texelFetch(uSt, ivec2(0), 0);
	o = vec4(s.xy, 0.0, 0.0);
}`;

/** Normalledd per piksel (MRT, tre mål, skalert med SC). */
const FS_TERMS = `${HEAD}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D uTw;
uniform sampler2D uRef;
uniform sampler2D uSt;
uniform sampler2D uStart;
uniform vec2 uGrid;
uniform float uBl;
float refAt(ivec2 p) { return texelFetch(uRef, clamp(p, ivec2(0), ivec2(uGrid) - 1), 0).r; }
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	vec2 e = texelFetch(uSt, ivec2(0), 0).xy - texelFetch(uStart, ivec2(0), 0).xy;
	vec2 px = 1.0 / uGrid;
	float Tv[9];
	float Rv[9];
	for (int j = 0; j < 3; j++) {
		for (int i = 0; i < 3; i++) {
			vec2 d = vec2(float(i - 1), float(j - 1)) * uBl;
			Tv[j * 3 + i] = texture(uTw, vUv + (e + d) * px).r;
			Rv[j * 3 + i] = refAt(p + ivec2(d));
		}
	}
	// binomial 1-2-1 og Sobel-gradient over same 3x3
	float T = (Tv[0] + 2.0 * Tv[1] + Tv[2] + 2.0 * (Tv[3] + 2.0 * Tv[4] + Tv[5]) + Tv[6] + 2.0 * Tv[7] + Tv[8]) / 16.0;
	float R = (Rv[0] + 2.0 * Rv[1] + Rv[2] + 2.0 * (Rv[3] + 2.0 * Rv[4] + Rv[5]) + Rv[6] + 2.0 * Rv[7] + Rv[8]) / 16.0;
	float Rx = ((Rv[2] + 2.0 * Rv[5] + Rv[8]) - (Rv[0] + 2.0 * Rv[3] + Rv[6])) / (8.0 * uBl);
	float Ry = ((Rv[6] + 2.0 * Rv[7] + Rv[8]) - (Rv[0] + 2.0 * Rv[1] + Rv[2])) / (8.0 * uBl);
	vec2 q = vUv + e * px;
	float inb = (q.x > 0.02 && q.x < 0.98 && q.y > 0.02 && q.y < 0.98) ? 1.0 : 0.0;
	float It = T - R;
	float g = length(vec2(Rx, Ry));
	float r = abs(It) / (g + 0.004);
	float c = 2.5 * uBl;
	float w = inb / (1.0 + (r * r) / (c * c));
	float s = ${SC}.0 * w;
	o0 = s * vec4(Rx * Rx, Rx * Ry, Ry * Ry, Rx * It);
	o1 = s * vec4(Ry * It, Rx, Ry, It);
	o2 = vec4(s, 0.0, 0.0, 1.0);
}`;

/** Løys 3×3 og oppdater forskyvinga. */
const FS_SOLVE = `${HEAD}
out vec4 o;
uniform sampler2D uT0;
uniform sampler2D uT1;
uniform sampler2D uT2;
uniform sampler2D uSt;
uniform float uLim;
uniform float uStep;
uniform float uEps;
void main() {
	ivec2 sz = textureSize(uT0, ${LVL});
	vec4 a = vec4(0.0);
	vec4 b = vec4(0.0);
	float W = 0.0;
	for (int y = 0; y < sz.y; y++) {
		for (int x = 0; x < sz.x; x++) {
			ivec2 p = ivec2(x, y);
			a += texelFetch(uT0, p, ${LVL});
			b += texelFetch(uT1, p, ${LVL});
			W += texelFetch(uT2, p, ${LVL}).x;
		}
	}
	float n = float(sz.x * sz.y);
	a /= n;
	b /= n;
	W /= n;
	vec4 st = texelFetch(uSt, ivec2(0), 0);
	float lam = 0.05 * 0.5 * (a.x + a.z) + 1e-4;
	float A = a.x + lam, B = a.y, C = a.z + lam, D = a.w;
	float E = b.x, F = b.y, G = b.z, H = b.w;
	vec2 e = vec2(0.0);
	float flag = st.z;
	if (flag < 0.5 && W > 0.06 * ${SC}.0) {
		// [A B -F; B C -G; F G -W] x = [-D; -E; -H]
		mat3 M = mat3(A, B, F, B, C, G, -F, -G, -W);
		float det = determinant(M);
		if (abs(det) > 1e-9) {
			vec3 x = inverse(M) * vec3(-D, -E, -H);
			e = clamp(x.xy, vec2(-uStep), vec2(uStep));
			if (length(e) < uEps) e = vec2(0.0);
		}
	}
	vec2 s = st.xy + e;
	if (max(abs(s.x), abs(s.y)) > uLim) {
		s = vec2(0.0);
		flag = 1.0;
	}
	o = vec4(s, flag, 0.0);
}`;

/** Referansen: flyt sakte mot det stabiliserte biletet. */
const FS_REF = `${HEAD}${LUMA}
out vec4 o;
uniform sampler2D uTw;
uniform sampler2D uRef;
uniform sampler2D uSt;
uniform sampler2D uStart;
uniform vec2 uGrid;
uniform float uK;
uniform float uInit;
void main() {
	vec4 st = texelFetch(uSt, ivec2(0), 0);
	vec2 e = st.xy - texelFetch(uStart, ivec2(0), 0).xy;
	float T = texture(uTw, vUv + e / uGrid).r;
	float r = texelFetch(uRef, ivec2(gl_FragCoord.xy), 0).r;
	float reset = (uInit > 0.5 || st.z > 0.5) ? 1.0 : 0.0;
	o = vec4(mix(mix(r, T, uK), T, reset), 0.0, 0.0, 1.0);
}`;

/** Full videoeksturen, forskyvd. */
const FS_OUT = `${HEAD}
out vec4 o;
uniform sampler2D uRaw;
uniform sampler2D uSt;
uniform vec2 uCover;
uniform vec2 uGrid;
void main() {
	vec2 s = texelFetch(uSt, ivec2(0), 0).xy;
	o = vec4(texture(uRaw, vUv + (s / uGrid) * uCover).rgb, 1.0);
}`;

export class Stabilizer {
	private gl: WebGL2RenderingContext;
	private pPre: Prog;
	private pMark: Prog;
	private pTerms: Prog;
	private pSolve: Prog;
	private pRef: Prog;
	private pOut: Prog;
	private gw = 0;
	private gh = 0;
	private ww = 0;
	private wh = 0;
	private tw!: Target;
	private ref: Target[] = [];
	private ri = 0;
	private st: Target[] = [];
	private start!: Target;
	private si = 0;
	private terms: Target[] = [];
	private termsFbo: WebGLFramebuffer | null = null;
	private out: Target | null = null;
	private init = true;
	private vw = 0;
	private vh = 0;

	constructor(private g: Gfx) {
		const gl = g.gl;
		this.gl = gl;
		this.pPre = new Prog(gl, FS_PRE, 'stab.pre');
		this.pMark = new Prog(gl, FS_MARK, 'stab.mark');
		this.pTerms = new Prog(gl, FS_TERMS, 'stab.terms');
		this.pSolve = new Prog(gl, FS_SOLVE, 'stab.solve');
		this.pRef = new Prog(gl, FS_REF, 'stab.ref');
		this.pOut = new Prog(gl, FS_OUT, 'stab.out');
	}

	/** Forskyvinga (i piksel i halv arbeidsoppløysing) til feilsøking. Stoppar GPU-en. */
	debug(): [number, number] {
		const a = new Float32Array(4);
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.st[this.si].fbo);
		gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, a);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return [a[0], a[1]];
	}

	reset() {
		this.init = true;
	}

	private alloc(ww: number, wh: number) {
		this.free();
		const g = this.g;
		const gl = this.gl;
		this.ww = ww;
		this.wh = wh;
		this.gw = ww >> 1;
		this.gh = wh >> 1;
		this.tw = g.target(ww, wh, g.U8, true);
		const f = g.hasF32 ? g.F32 : g.F16;
		this.ref = [g.target(this.gw, this.gh, f, false), g.target(this.gw, this.gh, f, false)];
		this.st = [g.target(1, 1, f, false), g.target(1, 1, f, false)];
		this.start = g.target(1, 1, f, false);
		for (const t of [...this.st, this.start]) {
			g.to(t);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
		// tre F16-mål med mipmap, teikna samtidig (MRT)
		this.terms = [0, 1, 2].map(() => g.target(this.gw, this.gh, g.F16, true, true));
		this.termsFbo = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.termsFbo);
		this.terms.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0));
		const stt = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		if (stt !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`stabilisering: MRT 0x${stt.toString(16)}`);
		this.init = true;
		this.si = 0;
		this.ri = 0;
	}

	private free() {
		this.tw?.del();
		this.ref.forEach((t) => t.del());
		this.st.forEach((t) => t.del());
		this.start?.del();
		this.terms.forEach((t) => t.del());
		if (this.termsFbo) this.gl.deleteFramebuffer(this.termsFbo);
		this.ref = [];
		this.st = [];
		this.terms = [];
		this.termsFbo = null;
	}

	/** Returnerer teksturen som oppsetta skal sjå (full videoleik, forskyvd). */
	run(raw: WebGLTexture, vw: number, vh: number, cover: [number, number], ww: number, wh: number): WebGLTexture {
		const g = this.g;
		const gl = this.gl;
		if (ww !== this.ww || wh !== this.wh) this.alloc(ww, wh);
		if (vw !== this.vw || vh !== this.vh || !this.out) {
			this.out?.del();
			this.out = g.target(vw, vh, g.U8, true);
			this.vw = vw;
			this.vh = vh;
		}
		const grid: [number, number] = [this.gw, this.gh];
		const cur = () => this.st[this.si];
		const flip = () => {
			this.si ^= 1;
		};

		// ny start (nytt oppsett, ny storleik): forskyvinga går tilbake til null
		if (this.init) {
			g.to(cur());
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}

		// 1. arbeidsbilete, med førre forskyving trekt frå
		g.to(this.tw);
		g.use(this.pPre);
		g.sampler(this.pPre, 'uRaw', 0, raw);
		g.sampler(this.pPre, 'uSt', 1, cur().tex);
		gl.uniform2f(this.pPre.u('uCover'), cover[0], cover[1]);
		gl.uniform2f(this.pPre.u('uGrid'), grid[0], grid[1]);
		g.quad();

		// 2. merk startpunkt for runden, og nullstill flagget
		g.to(this.start);
		g.use(this.pMark);
		g.sampler(this.pMark, 'uSt', 0, cur().tex);
		g.quad();
		g.to(this.st[1 - this.si]);
		g.quad();
		flip();

		if (this.init) {
			// første bilete: referansen er biletet slik det er
			this.refUpdate(grid, 1);
		} else {
			// 3. to rundar: uskarp (stor rekkevidde), så skarp
			for (const bl of [2, 1]) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, this.termsFbo);
				gl.viewport(0, 0, this.gw, this.gh);
				g.use(this.pTerms);
				g.sampler(this.pTerms, 'uTw', 0, this.tw.tex);
				g.sampler(this.pTerms, 'uRef', 1, this.ref[this.ri].tex);
				g.sampler(this.pTerms, 'uSt', 2, cur().tex);
				g.sampler(this.pTerms, 'uStart', 3, this.start.tex);
				gl.uniform2f(this.pTerms.u('uGrid'), grid[0], grid[1]);
				gl.uniform1f(this.pTerms.u('uBl'), bl);
				g.quad();
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				this.terms.forEach((t) => g.mipmap(t));

				g.to(this.st[1 - this.si]);
				g.use(this.pSolve);
				g.sampler(this.pSolve, 'uT0', 0, this.terms[0].tex);
				g.sampler(this.pSolve, 'uT1', 1, this.terms[1].tex);
				g.sampler(this.pSolve, 'uT2', 2, this.terms[2].tex);
				g.sampler(this.pSolve, 'uSt', 3, cur().tex);
				gl.uniform1f(this.pSolve.u('uLim'), 0.12 * this.gw);
				gl.uniform1f(this.pSolve.u('uStep'), bl * 2.5);
				gl.uniform1f(this.pSolve.u('uEps'), bl > 1 ? 0.05 : 0.015);
				g.quad();
				flip();
			}
			this.refUpdate(grid, 0.03);
		}
		this.init = false;

		// 4. full videotekstur med den målte forskyvinga
		g.to(this.out);
		g.use(this.pOut);
		g.sampler(this.pOut, 'uRaw', 0, raw);
		g.sampler(this.pOut, 'uSt', 1, cur().tex);
		gl.uniform2f(this.pOut.u('uCover'), cover[0], cover[1]);
		gl.uniform2f(this.pOut.u('uGrid'), grid[0], grid[1]);
		g.quad();
		return this.out.tex;
	}

	private refUpdate(grid: [number, number], k: number) {
		const g = this.g;
		const gl = this.gl;
		g.to(this.ref[1 - this.ri]);
		g.use(this.pRef);
		g.sampler(this.pRef, 'uTw', 0, this.tw.tex);
		g.sampler(this.pRef, 'uRef', 1, this.ref[this.ri].tex);
		g.sampler(this.pRef, 'uSt', 2, this.st[this.si].tex);
		g.sampler(this.pRef, 'uStart', 3, this.start.tex);
		gl.uniform2f(this.pRef.u('uGrid'), grid[0], grid[1]);
		gl.uniform1f(this.pRef.u('uK'), k);
		gl.uniform1f(this.pRef.u('uInit'), this.init ? 1 : 0);
		g.quad();
		this.ri ^= 1;
	}

	dispose() {
		this.free();
		this.out?.del();
		this.out = null;
	}
}
