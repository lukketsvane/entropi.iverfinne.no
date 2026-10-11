<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { updated } from '$app/state';
	import { DepthEstimator } from '../lib/pointcloud/estimator.mjs';
	import { PointCloudViewer } from '../lib/pointcloud/viewer.mjs';
	import { Viewfinder } from '../lib/pointcloud/viewfinder.mjs';
	import { FrameRecorder } from '../lib/pointcloud/recorder.mjs';
	import { imageToPointCloud, pointCloudPLY, pointStride } from '../../static/pointcloud/math.mjs';
	import { estimateImageDepth } from '../../static/pointcloud/tiles.mjs';
	import { captureSnapshot } from '../../static/pointcloud/panorama.mjs';
	import '../lib/pointcloud/studio.css';

	type Pixels = { data: Uint8ClampedArray; width: number; height: number };
	type Capture = Pixels & { inputFrames?: number; registeredFrames?: number; focalEstimate?: number; horizontal?: boolean };
	let video: HTMLVideoElement;
	let finder: HTMLCanvasElement;
	let photoInput: HTMLInputElement;
	let cloudHost: HTMLDivElement;
	let stream: MediaStream | null = null;
	let preview: Viewfinder | null = null;
	let viewer: PointCloudViewer | null = null;
	const estimator = new DepthEstimator();
	let mode = $state<'camera' | 'recording' | 'working' | 'done' | 'error'>('camera');
	let announcement = $state('Trykk for eitt bilete. Hald inne medan du panorerer, og slepp for å lage ei punktsky.');
	let progress = $state<number | null>(null);
	let plyUrl = $state('');
	let captured: Capture | null = null;
	let disposed = false;
	let generation = 0;
	let cameraAttempt = 0;
	let capturePointer: number | null = null;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let panoramaWorker: Worker | null = null;
	let rejectPanorama: ((error: unknown) => void) | null = null;
	let lastTap: { time: number; x: number; y: number } | null = null;
	let cloudPointer: { id: number; time: number; x: number; y: number } | null = null;

	function stopCamera() {
		cameraAttempt++;
		stream?.getTracks().forEach(track => track.stop());
		stream = null;
		if (video) video.srcObject = null;
	}
	function clearResult() {
		viewer?.dispose(); viewer = null;
		if (plyUrl) URL.revokeObjectURL(plyUrl);
		plyUrl = '';
	}
	function stopPanorama() {
		panoramaWorker?.terminate(); panoramaWorker = null;
		rejectPanorama?.(new DOMException('Avbrote.', 'AbortError')); rejectPanorama = null;
	}
	function showPixels(pixels: Pixels) {
		const canvas = document.createElement('canvas');
		canvas.width = pixels.width; canvas.height = pixels.height;
		canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
		if (preview) { preview.source = canvas; preview.active = true; }
	}
	function openCapture() {
		if (mode !== 'camera') return;
		stopCamera(); photoInput?.click();
	}
	async function startCamera() {
		if (disposed || mode !== 'camera' || stream || !video || !navigator.mediaDevices?.getUserMedia) return;
		const attempt = ++cameraAttempt;
		try {
			const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
			if (disposed || mode !== 'camera' || attempt !== cameraAttempt) {
				next.getTracks().forEach(track => track.stop()); return;
			}
			stream = next; video.srcObject = next;
			await video.play().catch(() => {});
			if (preview) { preview.source = video; preview.active = true; }
		} catch {
			announcement = 'Trykk i søkjaren for å bruke kameraet eller velje bilete.';
		}
	}
	function pixelsFor(source: CanvasImageSource, width: number, height: number, edge = 640): Pixels {
		const scale = Math.min(1, edge / Math.max(width, height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('Kunne ikkje lese biletet.');
		context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(source, 0, 0, canvas.width, canvas.height);
		return captureSnapshot(context.getImageData(0, 0, canvas.width, canvas.height));
	}
	const recorder = new FrameRecorder({
		capture: () => video?.readyState >= 2 && video.videoWidth ? pixelsFor(video, video.videoWidth, video.videoHeight) : null,
		onHold: () => { mode = 'recording'; announcement = 'Samlar bilete. Panorer langsamt med overlapp, og slepp når du er ferdig.'; },
		finish: frames => { capturePointer = null; void finishCapture(frames); },
		cancel: () => { capturePointer = null; if (mode === 'recording') mode = 'camera'; }
	});
	function beginCapture(event: PointerEvent) {
		if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || mode !== 'camera') return;
		if (!video || video.readyState < 2 || !video.videoWidth) return;
		event.preventDefault();
		capturePointer = event.pointerId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		try { recorder.begin(); } catch (error) { recorder.abort(); fail(error, ++generation); }
	}
	function endCapture(event: PointerEvent) {
		if (event.pointerId !== capturePointer) return;
		event.preventDefault(); recorder.end();
	}
	function cancelCapture(event: PointerEvent) {
		if (event.pointerId === capturePointer) recorder.abort();
	}
	function captureClick(event: MouseEvent) {
		if (mode !== 'camera') return;
		if (!video || video.readyState < 2 || !video.videoWidth) { openCapture(); return; }
		// Mouse/touch already finish on release; keyboard and assistive clicks still capture.
		if (event.detail === 0) void finishCapture([pixelsFor(video, video.videoWidth, video.videoHeight)]);
	}
	function stitch(frames: Pixels[]): Promise<Capture> {
		if (frames.length === 1) return Promise.resolve({ ...captureSnapshot(frames[0]), inputFrames: 1, registeredFrames: 1 });
		return new Promise((resolve, reject) => {
			const worker = new Worker('/pointcloud/panorama-worker.mjs?v=5', { type: 'module' });
			panoramaWorker = worker;
			const timer = setTimeout(() => finish(new Error('Panoramaet tok for lang tid. Prøv ei kortare rørsle.')), 60000);
			function finish(error: unknown, result?: Capture) {
				clearTimeout(timer); worker.terminate();
				if (panoramaWorker === worker) { panoramaWorker = null; rejectPanorama = null; }
				if (error) reject(error); else if (result) resolve(result);
			}
			rejectPanorama = error => finish(error);
			worker.onmessage = ({ data }) => {
				if (data.type === 'error') finish(new Error(data.message));
				else finish(null, { ...data, data: new Uint8ClampedArray(data.data) });
			};
			worker.onerror = () => finish(new Error('Kunne ikkje setje saman bileta.'));
			const input = frames.map(frame => ({ width: frame.width, height: frame.height, data: frame.data.buffer }));
			worker.postMessage(input, input.map(frame => frame.data as ArrayBuffer));
		});
	}
	async function finishCapture(frames: Pixels[], id = ++generation) {
		if (disposed || id !== generation) return;
		if (!frames.length) { mode = 'camera'; openCapture(); return; }
		try {
			clearResult(); captured = null; progress = null; mode = 'working';
			showPixels(frames[0]); stopCamera();
			announcement = frames.length > 1 ? 'Set saman overlappande bilete.' : 'Lagar punktsky.';
			const result = await stitch(frames);
			if (disposed || id !== generation) return;
			captured = result;
			await generateCloud(id);
		} catch (error) { fail(error, id); }
	}
	function fail(error: unknown, id: number) {
		if (disposed || id !== generation) return;
		clearResult(); stopCamera(); mode = 'error';
		announcement = error instanceof Error ? error.message : 'Kunne ikkje lage punktskyen. Trykk for å prøve igjen.';
	}
	async function generateCloud(id: number) {
		const pixels = captured;
		if (!pixels) return;
		mode = 'working'; progress = null;
		try {
			const prediction = await estimateImageDepth(pixels, estimator, update => {
				if (disposed || id !== generation) return;
				progress = update.percent ?? null;
				announcement = update.phase.startsWith('loading') ? 'Lastar djupnemodellen til eininga.' : 'Reknar djupn.';
			}, () => !disposed && id === generation);
			if (disposed || id !== generation) return;
			const cloud = imageToPointCloud({ rgba: pixels.data, width: pixels.width, height: pixels.height,
				depth: prediction.depth, depthWidth: prediction.width, depthHeight: prediction.height,
				stride: pointStride(pixels.width, pixels.height), focalEstimate: pixels.focalEstimate });
			mode = 'done'; if (preview) { preview.active = false; preview.source = null; }
			await tick();
			if (disposed || id !== generation || !cloudHost) return;
			viewer = new PointCloudViewer(cloudHost, cloud, error => fail(error, id));
			viewer.setStyle('mono');
			// Export what is shown: grayscale colours and estimated relative XYZ.
			for (let i = 0; i < cloud.count; i++) {
				const at = i * 3, gray = Math.round(cloud.colors[at] * .299 + cloud.colors[at + 1] * .587 + cloud.colors[at + 2] * .114);
				cloud.colors[at] = cloud.colors[at + 1] = cloud.colors[at + 2] = gray;
			}
			plyUrl = URL.createObjectURL(new Blob([pointCloudPLY(cloud)], { type: 'application/octet-stream' }));
			announcement = `${pixels.registeredFrames ?? 1} av ${pixels.inputFrames ?? 1} bilete registrerte. Punktsky klar. Dra for å rotere, bruk to fingrar for å zoome. Dobbelttrykk for eit nytt bilete. Djupna er estimert.`;
		} catch (error) { fail(error, id); }
	}
	async function decodePhoto(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
		if (typeof createImageBitmap === 'function') {
			try {
				const bitmap = await createImageBitmap(file);
				return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
			} catch { /* iOS can use its native decoder for additional image formats. */ }
		}
		const url = URL.createObjectURL(file), image = new Image();
		try {
			image.src = url; await image.decode();
			return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
		} catch { URL.revokeObjectURL(url); throw new Error('Kunne ikkje opne biletet. Prøv JPEG eller PNG.'); }
	}
	async function captureFiles(files: File[]) {
		if (!files.length || mode !== 'camera') return;
		const id = ++generation; mode = 'working'; stopCamera();
		try {
			const frames: Pixels[] = [];
			for (const file of files) {
				const decoded = await decodePhoto(file);
				try {
					if (disposed || id !== generation) return;
					frames.push(pixelsFor(decoded.source, decoded.width, decoded.height, files.length === 1 ? 840 : 640));
				} finally { decoded.close(); }
			}
			await finishCapture(frames, id);
		} catch (error) { fail(error, id); }
	}
	function capture(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []).slice(0, 32); input.value = '';
		void captureFiles(files);
	}
	function pasteCapture(event: ClipboardEvent) {
		if (mode !== 'camera') return;
		const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/')).slice(0, 32);
		if (!files.length) return;
		event.preventDefault(); void captureFiles(files);
	}
	async function retake() {
		generation++; recorder.abort(); estimator.dispose(); stopPanorama(); clearResult(); captured = null;
		progress = null; lastTap = null; mode = 'camera';
		announcement = 'Trykk for eitt bilete. Hald inne for fleire bilete.';
		if (preview) { preview.source = null; preview.active = true; }
		await tick(); void startCamera();
	}
	function retry() {
		if (!captured) { void retake(); return; }
		clearResult(); void generateCloud(++generation);
	}
	function cloudDown(event: PointerEvent) {
		if (!event.isPrimary) { cloudPointer = null; lastTap = null; return; }
		cloudPointer = { id: event.pointerId, time: performance.now(), x: event.clientX, y: event.clientY };
	}
	function cloudUp(event: PointerEvent) {
		const start = cloudPointer; cloudPointer = null;
		if (!start || start.id !== event.pointerId || performance.now() - start.time > 250 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
		const tap = { time: performance.now(), x: event.clientX, y: event.clientY };
		if (lastTap && tap.time - lastTap.time < 360 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 28) void retake();
		else lastTap = tap;
	}
	function keys(event: KeyboardEvent) {
		if (event.key === 'Escape') void retake();
	}
	onMount(() => {
		try { preview = new Viewfinder(finder); } catch { announcement = 'Kamerasøkjaren kunne ikkje startast. Trykk for å velje eit bilete.'; }
		void startCamera();
		const resume = () => {
			clearTimeout(resumeTimer);
			if (document.visibilityState !== 'visible') { recorder.abort(); return; }
			if (updated.current && mode === 'camera') { location.reload(); return; }
			resumeTimer = setTimeout(() => {
				if (mode === 'camera') {
					if (stream && !stream.getVideoTracks().some(track => track.readyState === 'live')) stopCamera();
					void startCamera();
				}
			}, 300);
		};
		window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
		return () => {
			disposed = true; generation++; clearTimeout(resumeTimer); recorder.abort();
			window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume);
			estimator.dispose(); stopPanorama(); stopCamera(); preview?.dispose(); clearResult(); captured = null;
		};
	});
</script>

<svelte:head>
	<title>entropi</title>
	<meta name="description" content="Eit stille kamera. Trykk for eit bilete, hald inne og panorer for ei punktsky av fleire bilete." />
	<meta name="apple-mobile-web-app-title" content="entropi" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
</svelte:head>
<svelte:window onkeydown={keys} onpaste={pasteCapture} />
<main class="studio" class:recording={mode === 'recording'} class:working={mode === 'working'} class:result={mode === 'done'}>
	<video bind:this={video} autoplay muted playsinline aria-hidden="true" tabindex="-1"></video>
	<div class="finder" class:hidden={mode === 'done'} aria-hidden="true">
		<canvas bind:this={finder}></canvas>
		<i class="cross"></i>
		{#if mode === 'recording'}<i class="record-light"></i>{/if}
		{#if mode === 'working'}
			<div class="progress" class:indeterminate={progress === null}><i style:width={progress === null ? '28%' : `${progress}%`}></i></div>
		{/if}
	</div>
	{#if mode === 'camera' || mode === 'recording'}
		<button class="capture-plane" type="button" aria-label="Ta bilete og lag 3D-punktsky. Hald inne for panorama."
			onpointerdown={beginCapture} onpointerup={endCapture} onpointercancel={cancelCapture} onlostpointercapture={cancelCapture} oncontextmenu={event => event.preventDefault()} onclick={captureClick}></button>
		<button class="access-control" type="button" aria-label="Vel bilete frå telefonen" onclick={openCapture}><i class="plus" aria-hidden="true"></i></button>
	{:else if mode === 'working'}
		<button class="capture-plane" type="button" aria-label="Dobbelttrykk for å avbryte berekninga" onpointerdown={cloudDown} onpointerup={cloudUp}></button>
		<button class="access-control" type="button" aria-label="Avbryt berekninga" onclick={retake}><i class="plus close" aria-hidden="true"></i></button>
	{:else if mode === 'error'}
		<button class="retry-plane" type="button" aria-label="Prøv igjen" onclick={retry}><i class="retry-mark" aria-hidden="true"></i></button>
	{/if}
	<!-- Native keyboard/screen-reader alternatives stay invisible until focus. -->
	<div class="cloud" class:hidden={mode !== 'done'} bind:this={cloudHost} onpointerdown={cloudDown} onpointerup={cloudUp} role="img" aria-label="Punktsky. Dra for å rotere, bruk to fingrar for å zoome. Dobbelttrykk for eit nytt bilete."></div>
	{#if mode === 'done'}
		<button class="access-control" type="button" aria-label="Ta eit nytt bilete" onclick={retake}><i class="plus" aria-hidden="true"></i></button>
		{#if plyUrl}<a class="access-control download" href={plyUrl} download="entropi-punktsky.ply" aria-label="Last ned 3D-punktsky som PLY"><i class="download-mark" aria-hidden="true"></i></a>{/if}
	{/if}
	<input bind:this={photoInput} type="file" accept="image/*" multiple onchange={capture} oncancel={() => void startCamera()} tabindex="-1" aria-label="Kamerabilete" />
	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
</main>
