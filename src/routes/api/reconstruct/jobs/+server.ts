import type { RequestHandler } from './$types';
import type { Config } from '@sveltejs/adapter-vercel';
import { reconstructionProxy } from '../../../../lib/server/reconstruction.mjs';
export const config: Config = { split: true, maxDuration: 60 };
export const POST: RequestHandler = ({request}) => reconstructionProxy().create(request);
