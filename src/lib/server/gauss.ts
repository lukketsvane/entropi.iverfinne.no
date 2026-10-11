import { timingSafeEqual } from 'node:crypto';

const maxImageBytes = 3_000_000;

function authorized(request: Request) {
	const expected = process.env.GAUSS_APP_KEY;
	if (!expected) return Response.json({ error: 'Tenesta er ikkje konfigurert enno.' }, { status: 503 });
	const supplied = request.headers.get('x-gauss-key') ?? '';
	const a = Buffer.from(supplied);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return Response.json({ error: 'Ugyldig tilgangskode.' }, { status: 401 });
	}
	return null;
}

export function validJobId(id: string) {
	return /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

export async function relay(request: Request, path: string, method: 'GET' | 'POST') {
	const rejection = authorized(request);
	if (rejection) return rejection;
	const base = process.env.GAUSS_BACKEND_URL;
	const token = process.env.GAUSS_BACKEND_TOKEN;
	if (!base || !token) return Response.json({ error: '3D-tenaren er ikkje tilkopla enno.' }, { status: 503 });
	let url: URL;
	try {
		const parsed = new URL(base);
		if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('Invalid backend URL');
		url = new URL(path, parsed);
	} catch {
		return Response.json({ error: '3D-tenaren er feil konfigurert.' }, { status: 503 });
	}
	const headers = new Headers({ authorization: `Bearer ${token}` });
	let body: ArrayBuffer | undefined;
	if (method === 'POST') {
		const type = request.headers.get('content-type') ?? '';
		if (!type.startsWith('multipart/form-data;')) return Response.json({ error: 'Vel eit bilete først.' }, { status: 415 });
		if (Number(request.headers.get('content-length')) > maxImageBytes) return Response.json({ error: 'Biletet er for stort.' }, { status: 413 });
		body = await request.arrayBuffer();
		if (body.byteLength > maxImageBytes) return Response.json({ error: 'Biletet er for stort.' }, { status: 413 });
		headers.set('content-type', type);
	}
	try {
		const upstream = await fetch(url, { method, headers, body, cache: 'no-store' });
		const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
		for (const name of ['content-type', 'content-disposition']) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
	} catch {
		return Response.json({ error: 'Fekk ikkje kontakt med 3D-tenaren.' }, { status: 502 });
	}
}
