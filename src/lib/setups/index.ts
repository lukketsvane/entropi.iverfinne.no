import type { Factory } from '../engine/types';
import { Blanding } from './blanding';
import { Bolgje } from './bolgje';
import { Demon } from './demon';
import { Ekko } from './ekko';
import { Flyt } from './flyt';
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
import { Spinn } from './spinn';
import { Tid } from './tid';
import { Tidsfarge } from './tidsfarge';
import { Vane } from './vane';

/**
 * Rekkjefølgja ein får når ein held to fingrar nede, og i veljaren: først ROM (kva ein ser i eitt bilete),
 * så TID (kva som endrar seg), så DYNAMIKK (system som køyrer av seg sjølve). Legg ny opstilling til her.
 */
export const SETUPS: Factory[] = [
	// rom
	() => new Soker(),
	() => new Rom(),
	// tid
	() => new Tid(),
	() => new Flyt(),
	() => new Hendelse(),
	() => new Marey(),
	() => new Khronos(),
	() => new Skan(),
	() => new Tidsfarge(),
	() => new Vane(),
	() => new Lang(),
	() => new Puls(),
	() => new Pil(),
	// dynamikk
	() => new Katt(),
	() => new Demon(),
	() => new Blanding(),
	() => new Ekko(),
	() => new Bolgje(),
	() => new Spinn()
];
