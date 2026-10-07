/**
 * Gestar på heile flata:
 *  - eitt trykk: onTap(x, y), koordinatar 0..1 (origo øvst til venstre)
 *  - to fingrar haldne nede i holdMs: onHold(), med framdrift 0..1 via onProgress()
 * Alt anna (klyping, rulling, dobbeltrykk-zoom) vert slått av.
 */
export interface GestureOpts {
	holdMs?: number;
	/** kor langt fingrane får gli før haldet vert avbrote, i piksel */
	slop?: number;
	onTap(x: number, y: number): void;
	onHold(): void;
	onProgress(p: number): void;
	onTouch?(): void;
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

	const tick = () => {
		if (!holdStart) return;
		const p = Math.min(1, (performance.now() - holdStart) / holdMs);
		setProgress(p);
		if (p >= 1) {
			fired = true;
			holdStart = 0;
			raf = 0;
			o.onHold();
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

	const down = (e: PointerEvent) => {
		o.onTouch?.();
		el.setPointerCapture?.(e.pointerId);
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
		if (pts.size >= 2) multi = true;
		if (pts.size === 2 && !fired) {
			// nullstill utgangspunktet så første fingeren ikkje tel mot slingringsmonnet
			for (const p of pts.values()) {
				p.x0 = p.x;
				p.y0 = p.y;
			}
			holdStart = performance.now();
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(tick);
		} else if (pts.size > 2) {
			stopHold();
		}
	};

	const move = (e: PointerEvent) => {
		const p = pts.get(e.pointerId);
		if (!p) return;
		p.x = e.clientX;
		p.y = e.clientY;
		if (holdStart && moved()) stopHold();
	};

	const up = (e: PointerEvent) => {
		const p = pts.get(e.pointerId);
		if (!p) return;
		pts.delete(e.pointerId);
		const dt = performance.now() - p.t0;
		const d = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
		if (pts.size < 2) stopHold();
		if (pts.size === 0) {
			if (!multi && !fired && dt < 450 && d < 14 && e.type === 'pointerup') {
				const r = el.getBoundingClientRect();
				o.onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
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
