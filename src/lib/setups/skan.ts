import type { Prog, Target } from '../engine/gl';
import type { Ctx, Meters, Setup, SetupInfo } from '../engine/types';
import { COVER_VIDEO, clamp01 } from './common';

/**
 * Sakte lukkar. Eit bilete er normalt eit augneblink. Her er det mange.
 *
 * Lukkaren er ei line som sveipar over biletet på nokre sekund, og lerretet hugsar det linja har sett. Det som
 * står stille ser vanleg ut. Det som rører seg vert skjevt: ein bil som køyrer same veg som linja vert strekt,
 * motsett veg vert pressa saman. Kvar rad er frå sitt eige øyeblink, og alle er med. Ein rullande lukkar (som i
 * telefonen din, men på 1/60 s) gjort så sakte at ein ser han. Slit-scan-tradisjonen: Iwai, Magyar, Levin.
 *
 * Linja skil notida frå fortida: rett over er det nyaste, rett under er det eldste (ein heil runde sidan).
 * Talet er alderen på biletet under sonden, i sekund.
 */
type Kind = 0 | 1 | 2; // 0 = ned, 1 = radar, 2 = mot høgre

interface Preset {
	kind: Kind;
	T: number;
	label: string;
	note: string;
}
const PRESETS: Preset[] = [
	{ kind: 0, T: 3, label: 'NED 3S', note: 'Lukkaren er ei line som sveipar nedover på tre sekund. Alt som rører seg vert skjevt.' },
	{ kind: 1, T: 4, label: 'RADAR 4S', note: 'Lukkaren er ein visar som går rundt. Trykk for å flytte midten.' },
	{ kind: 2, T: 2, label: 'HØGRE 2S', note: 'Lukkaren går frå venstre til høgre på to sekund.' },
	{ kind: 0, T: 1, label: 'NED 1S', note: 'Same lukkar, tre gongar så fort.' }
];

const FS_WRITE = `${COVER_VIDEO}
uniform int uKind;
uniform int uAll;
uniform vec2 uC;
uniform vec2 uWin;
uniform vec2 uA;
void main() {
	if (uAll == 0 && uKind == 1) {
		vec2 d = (vUv - uC) * uWin;
		float a = fract(atan(d.x, d.y) / 6.2831853);
		bool ok = uA.x <= uA.y ? (a >= uA.x && a <= uA.y) : (a >= uA.x || a <= uA.y);
		if (!ok) discard;
	}
	o = vec4(camera(vUv), 1.0);
}`;

const FS_DRAW = `
uniform sampler2D uCan;
uniform int uKind;
uniform float uPhase;
uniform vec2 uC;
uniform vec2 uWin;
void main() {
	vec3 col = texture(uCan, vUv).rgb;
	float dist = 1e4;
	if (uKind == 0) dist = (vUv.y - (1.0 - uPhase)) * uWin.y;
	else if (uKind == 2) dist = (vUv.x - uPhase) * uWin.x;
	else {
		vec2 d = (vUv - uC) * uWin;
		float ang = uPhase * 6.2831853;
		vec2 dir = vec2(sin(ang), cos(ang));
		float pr = dot(d, dir);
		dist = pr > 0.0 ? length(d - dir * pr) : 1e4;
	}
	float line = 1.0 - smoothstep(0.0, 2.2, abs(dist));
	float glow = exp(-abs(dist) / 12.0) * 0.22;
	col = col + vec3(glow) * (1.0 - line);
	col = mix(col, vec3(1.0), line * 0.9);
	float top = smoothstep(0.82, 1.0, vUv.y);
	float bot = smoothstep(0.20, 0.0, vUv.y);
	col *= 1.0 - 0.35 * top - 0.40 * bot;
	o = vec4(col, 1.0);
}`;

export class Skan implements Setup {
	readonly info: SetupInfo = {
		id: 'skan',
		code: 'SKA',
		group: 'tid',
		name: 'Sakte lukkar',
		blurb: 'Lukkaren er ei line som sveipar over biletet. Kvar rad er frå sitt eige augneblink.',
		how: 'Rør deg mot og med linja og sjå forskjellen. Trykk på talet nede til høgre for å bytte lukkar.',
		needsFloat: false,
		probe: true
	};

	private wP!: Prog;
	private dP!: Prog;
	private can!: Target;
	private pr = 0;
	private phase = 0;
	private last = -1;
	private first = true;
	private cx = 0.5;
	private cy = 0.5;
	private probe: [number, number] = [0.5, 0.5];

	init(ctx: Ctx) {
		const g = ctx.gfx;
		this.wP = g.prog('ska.write', FS_WRITE);
		this.dP = g.prog('ska.draw', FS_DRAW);
		this.can = g.target(ctx.sw, ctx.sh, g.U8, true);
	}

	private get pre() {
		return PRESETS[this.pr];
	}

	tap(_ctx: Ctx, x: number, y: number): boolean {
		if (this.pre.kind === 1) {
			this.cx = x;
			this.cy = y;
		}
		return false;
	}

	cycle(ctx: Ctx): string {
		this.pr = (this.pr + 1) % PRESETS.length;
		this.phase = 0;
		this.first = true;
		void ctx;
		return this.pre.note;
	}

	private write(ctx: Ctx, s0: number, s1: number, all: boolean) {
		const g = ctx.gfx;
		const gl = g.gl;
		const { kind } = this.pre;
		const W = this.can.w;
		const H = this.can.h;
		g.to(this.can);
		g.use(this.wP);
		g.sampler(this.wP, 'uVideo', 0, ctx.video);
		gl.uniform2f(this.wP.u('uCover'), ctx.cover[0], ctx.cover[1]);
		gl.uniform1i(this.wP.u('uKind'), kind);
		gl.uniform1i(this.wP.u('uAll'), all ? 1 : 0);
		gl.uniform2f(this.wP.u('uC'), this.cx, this.cy);
		gl.uniform2f(this.wP.u('uWin'), W, H);
		gl.uniform2f(this.wP.u('uA'), Math.max(0, s0 - 0.004), Math.min(1, s1 + 0.004));
		if (kind !== 1 && !all) {
			let x = 0;
			let y = 0;
			let w = W;
			let h = H;
			if (kind === 0) {
				y = Math.max(0, Math.floor((1 - s1) * H) - 1);
				h = Math.min(H, Math.ceil((1 - s0) * H) + 1) - y;
			} else {
				x = Math.max(0, Math.floor(s0 * W) - 1);
				w = Math.min(W, Math.ceil(s1 * W) + 1) - x;
			}
			if (w <= 0 || h <= 0) return;
			gl.enable(gl.SCISSOR_TEST);
			gl.scissor(x, y, w, h);
			g.quad();
			gl.disable(gl.SCISSOR_TEST);
		} else {
			g.quad();
		}
	}

	frame(ctx: Ctx) {
		this.probe = ctx.probe;
		const { kind, T } = this.pre;
		if (this.first) {
			this.first = false;
			this.last = ctx.now;
			this.write(ctx, 0, 1, true);
			return;
		}
		const dt = Math.min(0.25, Math.max(0, (ctx.now - this.last) / 1000));
		this.last = ctx.now;
		const prev = this.phase;
		const nxt = prev + dt / T;
		if (nxt < 1) {
			this.phase = nxt;
			this.write(ctx, prev, nxt, false);
		} else {
			this.phase = nxt - 1;
			this.write(ctx, prev, 1, false);
			this.write(ctx, 0, this.phase, false);
		}
		void kind;
	}

	draw(ctx: Ctx) {
		const g = ctx.gfx;
		const gl = g.gl;
		g.use(this.dP);
		g.sampler(this.dP, 'uCan', 0, this.can.tex);
		gl.uniform1i(this.dP.u('uKind'), this.pre.kind);
		gl.uniform1f(this.dP.u('uPhase'), this.phase);
		gl.uniform2f(this.dP.u('uC'), this.cx, this.cy);
		gl.uniform2f(this.dP.u('uWin'), this.can.w, this.can.h);
		g.quad();
	}

	meters(): Meters {
		const { kind, T } = this.pre;
		const [px, py] = this.probe;
		let s: number;
		if (kind === 0) s = 1 - py;
		else if (kind === 2) s = px;
		else {
			const dx = (px - this.cx) * this.can.w;
			const dy = (py - this.cy) * this.can.h;
			s = ((Math.atan2(dx, dy) / (2 * Math.PI)) % 1 + 1) % 1;
		}
		const age = (((this.phase - s) % 1) + 1) % 1;
		return {
			gauge: clamp01(this.phase),
			ruler: clamp01(age),
			value: (age * T).toFixed(1),
			chip: 'S',
			params: this.pre.label,
			rulerEnds: ['−', '+']
		};
	}

	dispose() {
		this.can?.del();
	}
}
