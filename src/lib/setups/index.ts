import type { Factory } from '../engine/types';
import { Blanding } from './blanding';
import { Demon } from './demon';
import { Hendelse } from './hendelse';
import { Katt } from './katt';
import { Khronos } from './khronos';
import { Lang } from './lang';
import { Marey } from './marey';
import { Pil } from './pil';
import { Puls } from './puls';
import { Rom } from './rom';
import { Skan } from './skan';
import { Soker } from './soker';
import { Tid } from './tid';
import { Tidsfarge } from './tidsfarge';
import { Vane } from './vane';

/** Rekkjefølgja ein får når ein held to fingrar nede. Legg ny opstilling til her. */
export const SETUPS: Factory[] = [
	() => new Katt(),
	() => new Demon(),
	() => new Hendelse(),
	() => new Marey(),
	() => new Skan(),
	() => new Khronos(),
	() => new Tidsfarge(),
	() => new Vane(),
	() => new Lang(),
	() => new Puls(),
	() => new Soker(),
	() => new Rom(),
	() => new Tid(),
	() => new Blanding(),
	() => new Pil()
];
