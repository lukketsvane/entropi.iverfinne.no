import { relay } from '../../../../lib/server/gauss.js';

export const prerender = false;

export function POST({ request }: { request: Request }) {
	return relay(request, '/api/jobs', 'POST');
}
