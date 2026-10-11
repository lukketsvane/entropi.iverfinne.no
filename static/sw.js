/* Skall-cache for heimskjerm-appen. Punktskyen treng nett til første modellnedlasting.
 * Verifiserte modellar har sin eigen cache; ikkje slett han når appskallet blir oppdatert.
 * HTML: nett først (ny deploy syner med ein gong), cache som reserve.
 * Alt anna frå same opphav: cache først, oppdater i bakgrunnen. */
const V = 'entropi-v4-minimal-panorama';

self.addEventListener('install', (e) => {
	e.waitUntil(
		caches
			.open(V)
			.then((c) =>
				c.addAll(['/', '/camera', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/michroma-latin-400-normal.woff2'])
			)
			.then(() => self.skipWaiting())
			.catch(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((ks) => Promise.all(ks.filter((k) => k.startsWith('entropi-v') && k !== V).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return;
	if (url.pathname === '/sw.js' || url.pathname.startsWith('/triposplat') || url.pathname === '/gauss' || url.pathname.startsWith('/gauss/') || url.pathname.startsWith('/api/gauss/') || url.pathname === '/gauss.webmanifest' || url.pathname === '/gauss-icon.png') return;

	if (req.mode === 'navigate') {
		e.respondWith(
			Promise.race([
				fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(V).then((c) => c.put(url.pathname, copy));
					}
					return res;
				}),
				new Promise((_, rej) => setTimeout(rej, 3500))
			]).catch(() => caches.match(url.pathname).then((r) => r || Response.error()))
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
