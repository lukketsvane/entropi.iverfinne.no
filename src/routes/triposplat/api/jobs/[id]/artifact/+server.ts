import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { backendRequest } from '../../../../../../lib/server/triposplat';

export const GET: RequestHandler = async ({ params, request }) => {
	if (!/^[A-Za-z0-9_-]{8,128}$/.test(params.id)) {
		return json({ error: 'Invalid job ID.' }, { status: 400 });
	}
	try {
		const pending = backendRequest(`/api/jobs/${params.id}/artifact`, { signal: request.signal });
		if (!pending) return json({ error: 'Generation service is not configured.' }, { status: 503 });
		const response = await pending;
		if (!response.ok) {
			const data = await response.json().catch(() => null);
			return json(
				{ error: typeof data?.error === 'string' ? data.error : 'Artifact is not available.' },
				{ status: response.status }
			);
		}
		const headers = new Headers({
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="triposplat-${params.id}.splat"`,
			'Cache-Control': 'no-store'
		});
		const size = response.headers.get('content-length');
		if (size) headers.set('Content-Length', size);
		return new Response(response.body, { headers });
	} catch {
		return json({ error: 'Generation server is unavailable. Try again shortly.' }, { status: 502 });
	}
};
