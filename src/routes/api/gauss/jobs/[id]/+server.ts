import { json } from '@sveltejs/kit';
import { relay, validJobId } from '../../../../../lib/server/gauss.js';

export const prerender = false;

export function GET({ request, params }: { request: Request; params: { id: string } }) {
	if (!validJobId(params.id)) return json({ error: 'Ugyldig jobb.' }, { status: 400 });
	return relay(request, `/api/jobs/${params.id}`, 'GET');
}
