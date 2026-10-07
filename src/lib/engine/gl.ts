/** Smale WebGL2-hjelparar. Ingen avhengnader. */

export interface Fmt {
	internal: number;
	format: number;
	type: number;
	/** kanalar per piksel */
	ch: number;
	label: string;
}

/** Eitt triangel som dekkjer heile skjermen. Ingen vertex-buffer trengst. */
export const VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	vUv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FS_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 o;
`;

export class Prog {
	readonly p: WebGLProgram;
	private locs = new Map<string, WebGLUniformLocation | null>();

	constructor(
		private gl: WebGL2RenderingContext,
		fs: string,
		readonly name = 'prog',
		vs: string = VS
	) {
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
				const log = gl.getShaderInfoLog(s) ?? '';
				gl.deleteShader(s);
				const numbered = src
					.split('\n')
					.map((l, i) => `${i + 1}: ${l}`)
					.join('\n');
				throw new Error(`shader ${name}: ${log}\n${numbered}`);
			}
			return s;
		};
		const v = compile(gl.VERTEX_SHADER, vs);
		const f = compile(gl.FRAGMENT_SHADER, fs);
		const p = gl.createProgram()!;
		gl.attachShader(p, v);
		gl.attachShader(p, f);
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
			throw new Error(`link ${name}: ${gl.getProgramInfoLog(p)}`);
		}
		gl.deleteShader(v);
		gl.deleteShader(f);
		this.p = p;
	}

	u(n: string): WebGLUniformLocation | null {
		let l = this.locs.get(n);
		if (l === undefined) {
			l = this.gl.getUniformLocation(this.p, n);
			this.locs.set(n, l);
		}
		return l;
	}
}

export class Target {
	constructor(
		private gl: WebGL2RenderingContext,
		readonly tex: WebGLTexture,
		readonly fbo: WebGLFramebuffer | null,
		readonly w: number,
		readonly h: number,
		readonly fmt: Fmt
	) {}
	del() {
		this.gl.deleteTexture(this.tex);
		if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
	}
}

export class Gfx {
	readonly gl: WebGL2RenderingContext;
	readonly U8: Fmt;
	readonly F16: Fmt;
	readonly F32: Fmt;
	readonly R32: Fmt;
	readonly hasF32: boolean;
	readonly hasF16: boolean;
	readonly maxTex: number;
	private progs = new Map<string, Prog>();
	private vao: WebGLVertexArrayObject;

	constructor(readonly canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			premultipliedAlpha: false,
			powerPreference: 'high-performance',
			preserveDrawingBuffer: false
		});
		if (!gl) throw new Error('WebGL2 manglar');
		this.gl = gl;
		const extF = gl.getExtension('EXT_color_buffer_float');
		const extH = gl.getExtension('EXT_color_buffer_half_float');
		gl.getExtension('OES_texture_float_linear');
		this.hasF32 = !!extF;
		this.hasF16 = !!extF || !!extH;
		this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
		this.U8 = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, ch: 4, label: 'rgba8' };
		this.F16 = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, ch: 4, label: 'rgba16f' };
		this.F32 = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, ch: 4, label: 'rgba32f' };
		this.R32 = { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, ch: 1, label: 'r32f' };
		this.vao = gl.createVertexArray()!;
		gl.bindVertexArray(this.vao);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
	}

	/** Kompilerer eitt fragment-program éin gong per namn. */
	prog(name: string, body: string): Prog {
		let p = this.progs.get(name);
		if (!p) {
			p = new Prog(this.gl, FS_HEAD + body, name);
			this.progs.set(name, p);
		}
		return p;
	}

	/** Beste flyttalsformat som kan teiknast til. */
	floatFmt(): Fmt {
		return this.hasF32 ? this.F32 : this.hasF16 ? this.F16 : this.U8;
	}

	texture(w: number, h: number, fmt: Fmt, linear: boolean, mips = false): WebGLTexture {
		const gl = this.gl;
		const t = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
		const f = linear ? gl.LINEAR : gl.NEAREST;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear && mips ? gl.LINEAR_MIPMAP_LINEAR : f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return t;
	}

	/** Tekstur + framebuffer. Kastar viss formatet ikkje kan teiknast til.
	 *  mips: tillat generateMipmap (gjennomsnitt over heile flata på øvste nivå). */
	target(w: number, h: number, fmt: Fmt, linear = true, mips = false): Target {
		const gl = this.gl;
		const lin = linear && fmt.type !== gl.FLOAT; // 32-bit flyttal er ikkje filtrerbart overalt
		const tex = this.texture(w, h, fmt, lin, mips && lin);
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		if (st !== gl.FRAMEBUFFER_COMPLETE) {
			gl.deleteTexture(tex);
			gl.deleteFramebuffer(fbo);
			throw new Error(`framebuffer ${fmt.label} ${w}x${h}: 0x${st.toString(16)}`);
		}
		return new Target(gl, tex, fbo, w, h, fmt);
	}

	use(p: Prog) {
		this.gl.useProgram(p.p);
	}

	/** Bind ein tekstur til ein eining og knyt han til ein sampler-uniform. */
	sampler(p: Prog, name: string, unit: number, tex: WebGLTexture | null, target: number = this.gl.TEXTURE_2D) {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(target, tex);
		gl.uniform1i(p.u(name), unit);
	}

	/** Set mål: ein Target eller skjermen (null). */
	to(t: Target | null, w?: number, h?: number) {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
		gl.viewport(0, 0, t ? t.w : (w ?? this.canvas.width), t ? t.h : (h ?? this.canvas.height));
	}

	quad() {
		this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
	}

	/** Les piksler frå ein Target (nedst til venstre er (0,0)). Stoppar GPU-en, bruk Reader i drift. */
	read(t: Target, out: ArrayBufferView, x = 0, y = 0, w = t.w, h = t.h) {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
		gl.readPixels(x, y, w, h, t.fmt.format, t.fmt.type, out);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	/** Mipmap-kjede for ein Target laga med mips=true. */
	mipmap(t: Target) {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, t.tex);
		gl.generateMipmap(gl.TEXTURE_2D);
	}
}

/**
 * Asynkron tilbakelesing av RGBA8 utan å stoppe rørsla: readPixels til PBO, fence, hent når GPU er ferdig.
 * Éi lesing om gongen. Resultatet kjem som Uint8Array via callback frå poll().
 */
export class Reader {
	private buf: WebGLBuffer;
	private cap = 0;
	private sync: WebGLSync | null = null;
	private cb: ((b: Uint8Array) => void) | null = null;
	private n = 0;
	private fallback = false;
	busy = false;

	constructor(private gl: WebGL2RenderingContext) {
		this.buf = gl.createBuffer()!;
	}

	/** false viss ei lesing allereie er i gang. */
	request(t: Target, x: number, y: number, w: number, h: number, cb: (b: Uint8Array) => void): boolean {
		if (this.busy) return false;
		const gl = this.gl;
		const bytes = w * h * 4;
		if (this.fallback) {
			const out = new Uint8Array(bytes);
			gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
			gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			cb(out);
			return true;
		}
		try {
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
			if (bytes > this.cap) {
				gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
				this.cap = bytes;
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
			gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
			const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
			if (!s) throw new Error('fenceSync');
			this.sync = s;
			gl.flush();
		} catch {
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
			this.fallback = true;
			return this.request(t, x, y, w, h, cb);
		}
		this.cb = cb;
		this.n = bytes;
		this.busy = true;
		return true;
	}

	/** Kall ein gong per bilete. */
	poll() {
		if (!this.busy || !this.sync) return;
		const gl = this.gl;
		const r = gl.clientWaitSync(this.sync, 0, 0);
		if (r === gl.TIMEOUT_EXPIRED) return;
		gl.deleteSync(this.sync);
		this.sync = null;
		const out = new Uint8Array(this.n);
		if (r !== gl.WAIT_FAILED) {
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
			gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, this.n);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
		}
		this.busy = false;
		const cb = this.cb;
		this.cb = null;
		if (r !== gl.WAIT_FAILED) cb?.(out);
	}

	dispose() {
		this.gl.deleteBuffer(this.buf);
		if (this.sync) this.gl.deleteSync(this.sync);
	}
}
