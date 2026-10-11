import { json } from '@sveltejs/kit';
import type { Config } from '@sveltejs/adapter-vercel';

// GPU proxy requests may exceed Vercel's 10-second default.
export const config: Config = { split: true, maxDuration: 60 };
import type { RequestHandler } from './$types';
import { backendRequest } from '../../../../../lib/server/triposplat';

export const GET: RequestHandler = async ({ params, request }) => {
	if (!/^[A-Za-z0-9_-]{8,128}$/.test(params.id)) {
		return json({ error: 'Invalid job ID.' }, { status: 400 });
	}
	try {
		const pending = backendRequest(`/api/jobs/${params.id}`, { signal: request.signal });
		if (!pending) return json({ error: 'Generation service is not configured.' }, { status: 503 });
		const response = await pending;
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			return json(
				{ error: typeof data?.error === 'string' ? data.error : 'Could not load job status.' },
				{ status: response.status }
			);
		}
		if (typeof data?.status !== 'string') {
			return json({ error: 'Generation service returned an invalid status.' }, { status: 502 });
		}
		return json(
			{
				id: params.id,
				status: data.status,
				stage: data.stage,
				progress: data.progress,
				sizeBytes: data.sizeBytes,
				error: data.error
			},
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch (error) {
		// Keep credentials out of logs, but retain the network failure class for diagnostics.
		const cause = error instanceof Error && 'cause' in error ? error.cause : null;
		console.error('TripoSplat status upstream:', error instanceof Error ? error.message : 'unknown',
			cause instanceof Error ? cause.message : '');
		return json({ error: 'Generation server is unavailable. Try again shortly.' }, { status: 502 });
	}
};
