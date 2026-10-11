import type { RequestHandler } from './$types';
import { reconstructionProxy } from '../../../../../lib/server/reconstruction.mjs';
export const GET: RequestHandler = ({params, request}) => reconstructionProxy().status(params.id, request);
