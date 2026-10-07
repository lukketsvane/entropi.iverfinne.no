/**
 * Gestar på heile flata:
 *  - eitt trykk: onTap(x, y), koordinatar 0..1 (origo øvst til venstre)
 *  - eitt finger nede eller dratt: onPoint(x, y, true), og onPoint(x, y, false) når det slepp
 *    (eller når eit nytt finger kjem til, då er det ikkje lenger eit pek)
 *  - to fingrar haldne nede i holdMs: onHold(1), med framdrift 0..1 via onProgress()
 *  - tre fingrar haldne nede i holdMs: onHold(-1), same framdrift
 * Alt anna (klyping, rulling, dobbeltrykk-zoom) vert slått av.
 */
export interface GestureOpts {
	holdMs?: number;
	/** kor langt fingrane får gli før haldet vert avbrote, i piksel */
	slop?: number;
	onTap(x: number, y: number): void;
	/** 1 = to fingrar (neste), -1 = tre fingrar (forrige) */
	onHold(dir: 1 | -1): void;
	onProgress(p: number): void;
	onTouch?(): void;
	onPoint?(x: number, y: number, down: boolean): void;
}

export function attachGestures(el: HTMLElement, o: GestureOpts): () => void {
	const holdMs = o.holdMs ?? 1200;
	const slop = o.slop ?? 28;
	const pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
	let holdStart = 0;
	let raf = 0;
	let fired = false;
	let multi = false; // har det vore to fingrar eller fleire i dette gestet
	let progress = 0;
	let pointDown = false;
	let last: [number, number] = [0.5, 0.5];

	const setProgress = (p: number) => {
		if (p !== progress) {
			progress = p;
			o.onProgress(p);
		}
	};

	const stopHold = () => {
		holdStart = 0;
		cancelAnimationFrame(raf);
		raf = 0;
		setProgress(0);
	};

	const norm = (cx: number, cy: number): [number, number] => {
		const r = el.getBoundingClientRect();
		return [(cx - r.left) / r.width, (cy - r.top) / r.height];
	};

	const releasePoint = () => {
		if (pointDown) {
			pointDown = false;
			o.onPoint?.(last[0], last[1], false);
		}
	};

	const tick = () => {
		if (!holdStart) return;
		const p = Math.min(1, (performance.now() - holdStart) / holdMs);
		setProgress(p);
		if (p >= 1) {
			fired = true;
			holdStart = 0;
			raf = 0;
			o.onHold(pts.size >= 3 ? -1 : 1);
			// hald ringen full ein augneblink, så ned
			setTimeout(() => setProgress(0), 140);
			return;
		}
		raf = requestAnimationFrame(tick);
	};

	const moved = () => {
		for (const p of pts.values()) {
			if (Math.hypot(p.x - p.x0, p.y - p.y0) > slop) return true;
		}
		return false;
	};

	const startHold = () => {
		// nullstill utgangspunktet så første fingeren ikkje tel mot slingringsmonnet
		for (const p of pts.values()) {
			p.x0 = p.x;
			p.y0 = p.y;
		}
		holdStart = performance.now();
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(tick);
	};

	const down = (e: PointerEvent) => {
		o.onTouch?.();
		el.setPointerCapture?.(e.pointerId);
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
		if (pts.size >= 2) {
			multi = true;
			releasePoint();
		}
		if (pts.size === 1 && !multi) {
			last = norm(e.clientX, e.clientY);
			pointDown = true;
			o.onPoint?.(last[0], last[1], true);
		}
		if ((pts.size === 2 || pts.size === 3) && !fired) startHold();
		else if (pts.size > 3) stopHold();
	};

	const move = (e: PointerEvent) => {
		const p = pts.get(e.pointerId);
		if (!p) return;
		p.x = e.clientX;
		p.y = e.clientY;
		if (holdStart && moved()) stopHold();
		if (pointDown && pts.size === 1) {
			last = norm(e.clientX, e.clientY);
			o.onPoint?.(last[0], last[1], true);
		}
	};

	const up = (e: PointerEvent) => {
		const p = pts.get(e.pointerId);
		if (!p) return;
		pts.delete(e.pointerId);
		const dt = performance.now() - p.t0;
		const d = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
		if (pts.size < 2) stopHold();
		if (pts.size === 0) {
			if (pointDown) {
				last = norm(e.clientX, e.clientY);
				releasePoint();
			}
			if (!multi && !fired && dt < 450 && d < 14 && e.type === 'pointerup') {
				const [x, y] = norm(e.clientX, e.clientY);
				o.onTap(x, y);
			}
			multi = false;
			fired = false;
		}
	};

	const stop = (e: Event) => e.preventDefault();
	const opts = { passive: false } as AddEventListenerOptions;

	el.addEventListener('pointerdown', down);
	el.addEventListener('pointermove', move);
	el.addEventListener('pointerup', up);
	el.addEventListener('pointercancel', up);
	// iOS: slå av klyping og dobbeltrykk-zoom
	document.addEventListener('gesturestart', stop, opts);
	document.addEventListener('gesturechange', stop, opts);
	document.addEventListener('gestureend', stop, opts);
	document.addEventListener('touchmove', stop, opts);
	el.addEventListener('contextmenu', stop);

	return () => {
		stopHold();
		releasePoint();
		el.removeEventListener('pointerdown', down);
		el.removeEventListener('pointermove', move);
		el.removeEventListener('pointerup', up);
		el.removeEventListener('pointercancel', up);
		document.removeEventListener('gesturestart', stop);
		document.removeEventListener('gesturechange', stop);
		document.removeEventListener('gestureend', stop);
		document.removeEventListener('touchmove', stop);
		el.removeEventListener('contextmenu', stop);
	};
}
