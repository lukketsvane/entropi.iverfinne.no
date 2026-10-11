import { json } from '@sveltejs/kit';
import type { Config } from '@sveltejs/adapter-vercel';

// GPU proxy requests may exceed Vercel's 10-second default.
export const config: Config = { split: true, maxDuration: 60 };
import type { RequestHandler } from './$types';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES } from '../../../../lib/triposplat';
import { backendRequest } from '../../../../lib/server/triposplat';

export const POST: RequestHandler = async ({ request }) => {
	const length = Number(request.headers.get('content-length'));
	if (length > MAX_UPLOAD_BYTES + 16_384) {
		return json({ error: 'Image must be 4 MB or smaller.' }, { status: 413 });
	}

	let image: FormDataEntryValue | null;
	try {
		image = (await request.formData()).get('image');
	} catch {
		return json({ error: 'Could not read the image upload.' }, { status: 400 });
	}
	if (!(image instanceof File) || !IMAGE_TYPES.includes(image.type)) {
		return json({ error: 'Choose a JPEG, PNG, or WebP image.' }, { status: 400 });
	}
	if (image.size > MAX_UPLOAD_BYTES) {
		return json({ error: 'Image must be 4 MB or smaller.' }, { status: 413 });
	}

	const form = new FormData();
	form.set('image', image, image.name);
	try {
		const pending = backendRequest('/api/jobs', { method: 'POST', body: form, signal: request.signal });
		if (!pending) return json({ error: 'Generation service is not configured.' }, { status: 503 });
		const response = await pending;
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			return json(
				{ error: typeof data?.error === 'string' ? data.error : 'Generation request failed.' },
				{ status: response.status }
			);
		}
		if (typeof data?.id !== 'string') {
			return json({ error: 'Generation service returned an invalid job.' }, { status: 502 });
		}
		return json({ id: data.id, status: data.status }, { headers: { 'Cache-Control': 'no-store' } });
	} catch {
		return json({ error: 'Generation server is unavailable. Try again shortly.' }, { status: 502 });
	}
};
