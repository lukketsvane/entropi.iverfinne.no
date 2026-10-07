/**
 * Haptikk på iOS Safari utan Vibration API: ein <input type=checkbox switch> i ein label gir eit tikk
 * (iOS 17.4+) når labelen vert klikka. Verkar helst berre i eller rett etter ein brukargest, så vi
 * kallar han frå touch-hendingar. Alt er «best effort»: om det ikkje tikkar, skjer ingenting.
 */
let label: HTMLLabelElement | null = null;

function make() {
	if (label || typeof document === 'undefined') return label;
	const l = document.createElement('label');
	l.setAttribute('aria-hidden', 'true');
	l.style.cssText =
		'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
	const i = document.createElement('input');
	i.type = 'checkbox';
	i.setAttribute('switch', '');
	i.tabIndex = -1;
	l.appendChild(i);
	document.body.appendChild(l);
	label = l;
	return l;
}

export function haptic(pattern: number | number[] = 12) {
	try {
		if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
			navigator.vibrate(pattern);
			return;
		}
	} catch {
		/* ignorer */
	}
	try {
		make()?.click();
	} catch {
		/* ignorer */
	}
}
