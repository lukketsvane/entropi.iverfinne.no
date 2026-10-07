import type { Gfx, Target } from './gl';

/** Det HUD-en viser. Alt er normalisert til 0..1 der det skal teiknast. */
export interface Meters {
	/** fyllgrad på batteriet nede til venstre (heile biletet) */
	gauge: number;
	/** plassering til trekanten på linjalen */
	ruler: number;
	/** hovudtalet øvst til høgre */
	value: string;
	/** einingsmerket i kvit boks, til venstre for talet */
	chip: string;
	/** parametrane nede til høgre, til dømes «9x9 16B» */
	params: string;
	/** kva linjalen måler, for ende-merkinga: [venstre, høgre] */
	rulerEnds: [string, string];
}

export interface SetupInfo {
	id: string;
	/** tre-fire bokstavar, store, øvst til venstre */
	code: string;
	name: string;
	/** éi linje på nynorsk som vert vist ein augneblink etter bytet */
	blurb: string;
	/** kan ikkje køyrast utan flyttalsmål */
	needsFloat: boolean;
	/** viser sondepunktet (spotmålar) */
	probe: boolean;
	/** éi linje på nynorsk om kva ein gjer: vert vist saman med blurb første gongen, og når ein trykkjer på koden */
	how?: string;
	/** oppsettet vil ha trykk-og-hald (touch), ikkje berre eit trykk. Sonden fylgjer fingeren. */
	press?: boolean;
}

/** Alt eit oppsett treng for å kunne teikne eitt bilete. */
export interface Ctx {
	gfx: Gfx;
	/** full oppløysing frå kameraet */
	video: WebGLTexture;
	/** skala som får videoen til å dekkje skjermen (cover) */
	cover: [number, number];
	/** arbeidsoppløysing */
	w: number;
	h: number;
	/** siste og førre bilete: rgb, luma i alfa */
	cur: Target;
	prev: Target;
	/** sondepunkt, 0..1, origo nede til venstre */
	probe: [number, number];
	/** storleik på lerretet i piksel */
	sw: number;
	sh: number;
	frameNo: number;
	/** ms sidan start */
	now: number;
	/** be om asynkron lesing av eit utsnitt, false viss opptatt */
	read(t: Target, x: number, y: number, w: number, h: number, cb: (b: Uint8Array) => void): boolean;
}

export interface Setup {
	readonly info: SetupInfo;
	init(ctx: Ctx): void;
	/** kvart nytt kamerabilete */
	frame(ctx: Ctx): void;
	/** teikn til skjermen */
	draw(ctx: Ctx): void;
	meters(): Meters;
	/** true viss oppsettet brukar trykket sjølv (då flyttast ikkje sonden) */
	tap?(ctx: Ctx, x: number, y: number): boolean;
	/** Eitt finger nede eller dratt: x,y 0..1 med origo nede til venstre. down=false når fingeren slepp. */
	touch?(ctx: Ctx, x: number, y: number, down: boolean): void;
	/** Trykk på parametrane: neste grovkorning. Returnerer ei kort lapp som vert vist ein augneblink. */
	cycle?(ctx: Ctx): string;
	dispose(): void;
}

export type Factory = () => Setup;
