<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { updated } from '$app/state';
	import { DepthEstimator } from '../lib/pointcloud/estimator.mjs';
	import { imageToPointCloud, pointCloudPLY, inferenceSize, pointStride } from '../../static/pointcloud/math.mjs';

	let video = $state<HTMLVideoElement | undefined>();
	let photoInput = $state<HTMLInputElement | undefined>();
	let cloudHost = $state<HTMLDivElement | undefined>();
	let stream: MediaStream | null = null;
	let viewer: { reset(): void; dispose(): void } | null = null;
	const estimator = new DepthEstimator();
	let mode = $state<'camera' | 'working' | 'done' | 'error'>('camera');
	let announcement = $state('');
	let errorMessage = $state('');
	let capturedUrl = $state('');
	let plyUrl = $state('');
	let capturedImage: File | null = null;
	let capturedPixels = $state.raw<ImageData | null>(null);
	let disposed = false;
	let generation = 0;
	let cameraAttempt = 0;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;

	function stopCamera() {
		cameraAttempt++;
		stream?.getTracks().forEach((track) => track.stop());
		stream = null;
		if (video) video.srcObject = null;
	}

	function clearResult() {
		viewer?.dispose();
		viewer = null;
		if (plyUrl) URL.revokeObjectURL(plyUrl);
		plyUrl = '';
	}

	function clearCapture() {
		clearResult();
		if (capturedUrl) URL.revokeObjectURL(capturedUrl);
		capturedUrl = '';
		capturedImage = null;
		capturedPixels = null;
	}

	function openCapture() {
		if (mode !== 'camera') return;
		stopCamera();
		photoInput?.click();
	}

	async function startCamera() {
		if (disposed || mode !== 'camera' || stream || !video || !navigator.mediaDevices?.getUserMedia) return;
		const attempt = ++cameraAttempt;
		try {
			const next = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' } }, audio: false
			});
			if (disposed || mode !== 'camera' || attempt !== cameraAttempt) {
				next.getTracks().forEach((track) => track.stop());
				return;
			}
			stream = next;
			video.srcObject = next;
			await video.play().catch(() => {});
		} catch {
			announcement = 'Trykk på utløysaren for å bruke kameraet eller velje eit bilete.';
		}
	}

	onMount(() => {
		void startCamera();
		const resume = () => {
			clearTimeout(resumeTimer);
			if (document.visibilityState !== 'visible') return;
			if (updated.current && mode === 'camera') { location.reload(); return; }
			resumeTimer = setTimeout(() => {
				if (mode === 'camera') {
					if (stream && !stream.getVideoTracks().some((track) => track.readyState === 'live')) stopCamera();
					void startCamera();
				}
			}, 300);
		};
		window.addEventListener('focus', resume);
		document.addEventListener('visibilitychange', resume);
		return () => {
			disposed = true;
			generation++;
			clearTimeout(resumeTimer);
			window.removeEventListener('focus', resume);
			document.removeEventListener('visibilitychange', resume);
			estimator.dispose();
			stopCamera();
			clearCapture();
		};
	});

	function canvasFor(source: CanvasImageSource, width: number, height: number) {
		const scale = Math.min(1, 840 / Math.max(width, height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('Kunne ikkje lese biletet.');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(source, 0, 0, canvas.width, canvas.height);
		return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height) };
	}

	async function saveCapture(canvas: HTMLCanvasElement, pixels: ImageData, id: number) {
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Kunne ikkje lagre biletet.')), 'image/jpeg', .92);
		});
		if (disposed || id !== generation) return;
		capturedPixels = pixels;
		capturedImage = new File([blob], 'entropi-bilete.jpg', { type: 'image/jpeg' });
		capturedUrl = URL.createObjectURL(blob);
		await generateCloud(id);
	}

	function fail(error: unknown, id: number) {
		if (disposed || id !== generation) return;
		clearResult();
		errorMessage = error instanceof Error ? error.message : 'Kunne ikkje lage punktskyen.';
		announcement = errorMessage;
		mode = 'error';
	}

	async function takePhoto() {
		if (mode !== 'camera') return;
		if (!video || video.readyState < 2 || !video.videoWidth) {
			openCapture();
			return;
		}
		const id = ++generation;
		try {
			const { canvas, pixels } = canvasFor(video, video.videoWidth, video.videoHeight);
			mode = 'working';
			announcement = 'Lagar punktsky.';
			stopCamera();
			await saveCapture(canvas, pixels, id);
		} catch (error) { fail(error, id); }
	}

	async function decodePhoto(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
		if (typeof createImageBitmap === 'function') {
			try {
				const bitmap = await createImageBitmap(file);
				return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
			} catch { /* Safari may support an image through its native decoder instead. */ }
		}
		const url = URL.createObjectURL(file);
		const image = new Image();
		try {
			image.src = url;
			await image.decode();
			return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
		} catch {
			URL.revokeObjectURL(url);
			throw new Error('Kunne ikkje opne biletet. Prøv JPEG eller PNG.');
		}
	}

	async function capture(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const selected = input.files?.[0];
		input.value = '';
		if (!selected || mode !== 'camera') return;
		const id = ++generation;
		clearCapture();
		errorMessage = '';
		mode = 'working';
		announcement = 'Les biletet.';
		stopCamera();
		try {
			const decoded = await decodePhoto(selected);
			try {
				if (disposed || id !== generation) return;
				const { canvas, pixels } = canvasFor(decoded.source, decoded.width, decoded.height);
				await saveCapture(canvas, pixels, id);
			} finally { decoded.close(); }
		} catch (error) { fail(error, id); }
	}

	async function generateCloud(id: number) {
		if (!capturedPixels) return;
		const pixels = capturedPixels;
		mode = 'working';
		errorMessage = '';
		announcement = 'Lagar punktsky.';
		const size = inferenceSize(pixels.width, pixels.height);
		const original = document.createElement('canvas');
		original.width = pixels.width;
		original.height = pixels.height;
		original.getContext('2d')!.putImageData(pixels, 0, 0);
		const input = document.createElement('canvas');
		input.width = size.width;
		input.height = size.height;
		const context = input.getContext('2d')!;
		context.drawImage(original, 0, 0, size.width, size.height);
		const data = context.getImageData(0, 0, size.width, size.height);
		try {
			const prediction = await estimator.estimate(data.data, size.width, size.height, (progress: { phase: string; percent?: number }) => {
				if (disposed || id !== generation) return;
				announcement = progress.phase.startsWith('loading')
					? `Lastar 3D-modellen, ${progress.percent ?? 0} prosent.` : 'Bereknar djupn og lagar punktsky.';
			});
			if (disposed || id !== generation) return;
			const cloud = imageToPointCloud({ rgba: pixels.data, width: pixels.width, height: pixels.height,
				depth: prediction.depth, depthWidth: prediction.width, depthHeight: prediction.height,
				stride: pointStride(pixels.width, pixels.height) });
			const { PointCloudViewer } = await import('../lib/pointcloud/viewer.mjs');
			if (disposed || id !== generation) return;
			mode = 'done';
			await tick();
			if (disposed || id !== generation || !cloudHost) return;
			viewer = new PointCloudViewer(cloudHost, cloud, (error: Error) => fail(error, id));
			const ply = pointCloudPLY(cloud);
			plyUrl = URL.createObjectURL(new Blob([ply], { type: 'application/octet-stream' }));
			announcement = 'Punktsky klar. Dra for å rotere, bruk to fingrar for å zoome. Djupna er estimert frå biletet.';
		} catch (error) { fail(error, id); }
	}

	async function retake() {
		generation++;
		estimator.dispose();
		clearCapture();
		errorMessage = '';
		mode = 'camera';
		announcement = '';
		await tick();
		void startCamera();
	}

	function retry() {
		if (!capturedPixels) { void retake(); return; }
		clearResult();
		void generateCloud(++generation);
	}

	async function sharePhoto(event: MouseEvent) {
		if (!capturedImage || !navigator.share) return;
		if (navigator.canShare && !navigator.canShare({ files: [capturedImage] })) return;
		event.preventDefault();
		try { await navigator.share({ files: [capturedImage] }); }
		catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
			if (capturedUrl) window.open(capturedUrl, '_blank', 'noopener');
		}
	}
</script>

<svelte:head>
	<title>entropi · punktsky</title>
	<meta name="description" content="Ta eit bilete og sjå det som ei farga 3D-punktsky. Biletet blir handsama lokalt på telefonen." />
</svelte:head>

<main class="camera">
	<video bind:this={video} class:hidden={mode !== 'camera'} autoplay muted playsinline></video>
	{#if capturedUrl && mode !== 'done'}
		<img class="photo" src={capturedUrl} alt="Biletet som blir til ei punktsky" />
	{/if}
	<div class="cloud" class:hidden={mode !== 'done'} bind:this={cloudHost}></div>
	{#if mode === 'camera'}
		<button class="capture" type="button" aria-label="Ta eit bilete og lag ei 3D-punktsky" onclick={takePhoto}><span class="shutter" aria-hidden="true"></span></button>
		<button class="icon gallery" type="button" aria-label="Vel eit bilete frå telefonen" onclick={openCapture}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3zM3 17l5-5 4 4 4-6 5 7" /><circle cx="8" cy="8" r="1" /></svg>
		</button>
	{:else}
		<button class="icon retake" type="button" aria-label={mode === 'working' ? 'Avbryt og ta eit nytt bilete' : 'Ta eit nytt bilete'} onclick={retake}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M5.5 9A7 7 0 0 1 18 7l2 4M4 13l2 4a7 7 0 0 0 12.5-2" /></svg>
		</button>
	{/if}
	{#if mode === 'working'}
		<div class="working" role="progressbar" aria-label={announcement}><span></span></div>
	{:else if mode === 'done'}
		<button class="icon reset" type="button" aria-label="Tilbakestill 3D-visinga" onclick={() => viewer?.reset()}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 12h8M12 8v8" /></svg>
		</button>
		{#if plyUrl}
			<a class="icon download" href={plyUrl} download="entropi-punktsky.ply" aria-label="Last ned 3D-punktsky som PLY">
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v4h16v-4" /></svg>
			</a>
		{/if}
	{:else if mode === 'error'}
		<div class="error" role="alert">
			<p>{errorMessage}</p>
			<button class="retry" type="button" onclick={retry}>{capturedPixels ? 'Prøv igjen' : 'Ta eit nytt bilete'}</button>
		</div>
	{/if}
	{#if capturedUrl}
		<a class="icon share-photo" href={capturedUrl} target="_blank" rel="noopener" aria-label="Del eller lagre biletet for utskrift" onclick={sharePhoto}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0 5 5m-5-5L7 8M4 14v7h16v-7" /></svg>
		</a>
	{/if}
	<input bind:this={photoInput} id="photo" type="file" accept="image/*" onchange={capture} oncancel={() => void startCamera()} />
	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
</main>

<style>
	.camera { position: fixed; inset: 0; overflow: hidden; background: #000; }
	video, .photo, .cloud { position: absolute; inset: 0; display: block; width: 100%; height: 100%; border: 0; object-fit: cover; }
	.photo { object-fit: contain; opacity: .65; }
	.cloud { touch-action: none; }
	.cloud :global(canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
	.hidden { visibility: hidden; pointer-events: none; }
	.capture { position: absolute; inset: 0; display: flex; justify-content: center; align-items: end; padding-bottom: max(28px, env(safe-area-inset-bottom)); border: 0; background: transparent; cursor: pointer; }
	.shutter { width: 74px; height: 74px; border: 4px solid #fff; border-radius: 50%; box-shadow: 0 0 0 2px #0008; display: grid; place-items: center; }
	.shutter::after { content: ''; width: 54px; height: 54px; border-radius: 50%; background: #fff; }
	input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
	.working { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
	.working span { width: 56px; height: 56px; border: 4px solid #fff5; border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.icon { position: absolute; z-index: 2; display: grid; place-items: center; width: 48px; height: 48px; background: #0009; border: 1px solid #fff7; border-radius: 50%; color: #fff; cursor: pointer; }
	.retake, .gallery { top: max(18px, env(safe-area-inset-top)); left: 18px; }
	.download { top: max(18px, env(safe-area-inset-top)); right: 76px; }
	.share-photo { top: max(18px, env(safe-area-inset-top)); right: 18px; }
	.reset { left: 18px; bottom: max(18px, env(safe-area-inset-bottom)); }
	svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.error { position: absolute; inset: auto 20px max(90px, env(safe-area-inset-bottom)); padding: 16px; border-radius: 12px; background: #000c; text-align: center; }
	.error p { margin: 0 0 12px; }
	.retry { padding: 10px 20px; border: 1px solid #fff7; border-radius: 24px; background: transparent; color: #fff; font: inherit; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
	@media (prefers-reduced-motion: reduce) { .working span { animation-duration: 3s; } }
</style>
