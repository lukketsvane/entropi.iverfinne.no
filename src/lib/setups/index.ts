import type { Factory } from '../engine/types';
import { Blanding } from './blanding';
import { Pil } from './pil';
import { Rom } from './rom';
import { Soker } from './soker';
import { Tid } from './tid';

/** Rekkjefølgja ein får når ein held to fingrar nede. Legg ny opstilling til her. */
export const SETUPS: Factory[] = [
	() => new Soker(),
	() => new Rom(),
	() => new Tid(),
	() => new Blanding(),
	() => new Pil()
];
