/* Skall-cache for heimskjerm-appen. Kameraet treng ikkje nett, så etter to opningar startar alt utan dekning.
 * HTML: nett først (ny deploy syner med ein gong), cache som reserve.
 * Alt anna frå same opphav: cache først, oppdater i bakgrunnen. */
const V = 'entropi-v1';

self.addEventListener('install', (e) => {
	e.waitUntil(
		caches
			.open(V)
			.then((c) =>
				c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/michroma-latin-400-normal.woff2'])
			)
			.then(() => self.skipWaiting())
			.catch(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return;
	if (url.pathname === '/sw.js') return;

	if (req.mode === 'navigate') {
		e.respondWith(
			Promise.race([
				fetch(req).then((res) => {
					const copy = res.clone();
					caches.open(V).then((c) => c.put('/', copy));
					return res;
				}),
				new Promise((_, rej) => setTimeout(rej, 3500))
			]).catch(() => caches.match('/').then((r) => r || Response.error()))
		);
		return;
	}

	e.respondWith(
		caches.open(V).then(async (c) => {
			const hit = await c.match(req);
			const net = fetch(req)
				.then((res) => {
					if (res.ok) c.put(req, res.clone());
					return res;
				})
				.catch(() => hit);
			return hit || net;
		})
	);
});
