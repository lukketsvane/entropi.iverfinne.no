export type CamErrKind = 'denied' | 'none' | 'insecure' | 'busy' | 'other';

export class CamError extends Error {
	constructor(
		public kind: CamErrKind,
		msg: string
	) {
		super(msg);
	}
}

/**
 * Opnar bakkameraet. ?src=<url> byter ut kameraet med ein videofil (testing).
 * Videoelementet må liggje i DOM-en (ikkje display:none) for at iOS skal levere bilete.
 */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream | null> {
	video.muted = true;
	video.defaultMuted = true;
	video.playsInline = true;
	video.setAttribute('playsinline', '');
	video.setAttribute('webkit-playsinline', '');
	video.autoplay = true;

	const src = new URLSearchParams(location.search).get('src');
	if (src) {
		video.srcObject = null;
		video.loop = true;
		video.src = src;
		await video.play();
		await ready(video);
		return null;
	}

	if (!navigator.mediaDevices?.getUserMedia) {
		throw new CamError('insecure', 'Kamera krev https');
	}

	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				facingMode: { ideal: 'environment' },
				width: { ideal: 1280 },
				height: { ideal: 720 },
				frameRate: { ideal: 30, max: 30 }
			}
		});
	} catch (e) {
		const n = (e as DOMException)?.name;
		if (n === 'NotAllowedError' || n === 'SecurityError') throw new CamError('denied', n);
		if (n === 'NotFoundError' || n === 'OverconstrainedError') throw new CamError('none', n);
		if (n === 'NotReadableError' || n === 'AbortError') throw new CamError('busy', n);
		throw new CamError('other', String(e));
	}
	video.srcObject = stream;
	try {
		await video.play();
	} catch (e) {
		stream.getTracks().forEach((t) => t.stop());
		throw new CamError('other', String(e));
	}
	await ready(video);
	return stream;
}

function ready(video: HTMLVideoElement): Promise<void> {
	return new Promise((res) => {
		if (video.videoWidth > 0 && video.readyState >= 2) return res();
		const done = () => {
			if (video.videoWidth > 0) {
				video.removeEventListener('loadeddata', done);
				video.removeEventListener('resize', done);
				res();
			}
		};
		video.addEventListener('loadeddata', done);
		video.addEventListener('resize', done);
		setTimeout(res, 4000);
	});
}

export function stopCamera(video: HTMLVideoElement) {
	const s = video.srcObject as MediaStream | null;
	s?.getTracks().forEach((t) => t.stop());
	video.srcObject = null;
}

/** Er straumen levande? (iOS drep han ofte når appen går i bakgrunnen.) */
export function cameraAlive(video: HTMLVideoElement): boolean {
	const s = video.srcObject as MediaStream | null;
	if (!s) return !video.paused && !video.ended;
	const t = s.getVideoTracks()[0];
	return !!t && t.readyState === 'live' && !t.muted;
}
