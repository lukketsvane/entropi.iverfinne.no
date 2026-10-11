export function backendRequest(path: string, init: RequestInit = {}): Promise<Response> | null {
	const base = process.env.TRIPOSPLAT_BACKEND_URL?.trim();
	const token = process.env.TRIPOSPLAT_BACKEND_TOKEN?.trim();
	if (!base || !token) return null;

	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${token}`);
	return fetch(new URL(path, base.endsWith('/') ? base : `${base}/`), {
		...init,
		headers,
		cache: 'no-store'
	});
}
