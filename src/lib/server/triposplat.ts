export function backendRequest(
	path: string,
	init: RequestInit = {},
	timeoutMs = 15_000
): Promise<Response> | null {
	const base = process.env.TRIPOSPLAT_BACKEND_URL?.trim();
	const token = process.env.TRIPOSPLAT_BACKEND_TOKEN?.trim();
	if (!base || !token) return null;

	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${token}`);
	// Bound the Shadow/GPU connection time, even if the host is unreachable.
	// Client disconnects still cancel the request.
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
	return fetch(new URL(path, base.endsWith('/') ? base : `${base}/`), {
		...init,
		headers,
		signal,
		cache: 'no-store'
	});
}
