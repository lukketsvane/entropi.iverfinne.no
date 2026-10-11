<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { updated } from '$app/state';
	import { DepthEstimator } from '../lib/pointcloud/estimator.mjs';
	import '../lib/pointcloud/studio.css';
	import { imageToPointCloud, pointCloudPLY, inferenceSize, pointStride } from '../../static/pointcloud/math.mjs';

	let video = $state<HTMLVideoElement | undefined>();
	let photoInput = $state<HTMLInputElement | undefined>();
	let cloudHost = $state<HTMLDivElement | undefined>();
	let stream: MediaStream | null = null;
	let viewer: { reset(): void; dispose(): void; setStyle(style: 'color' | 'silver' | 'depth'): void; setPointSize(size: number): void } | null = null;
	const estimator = new DepthEstimator();
	let mode = $state<'camera' | 'working' | 'done' | 'error'>('camera');
	let announcement = $state('');
	let errorMessage = $state('');
	let progressPhase = $state('KLARGJER');
	let progressPercent = $state<number | null>(null);
	let visualStyle = $state<'color' | 'silver' | 'depth'>('color');
	let pointSize = $state(1);
	let showOriginal = $state(false);
	let cameraReady = $state(false);
	let cloudCount = $state(0);
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
		cameraReady = false;
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
		showOriginal = false;
		cloudCount = 0;
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
			cameraReady = video.readyState >= 2;
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
			progressPhase = 'FANGAR LYS';
			progressPercent = null;
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
		progressPhase = 'LES BILETET';
		progressPercent = null;
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
		progressPhase = 'BYGGJER ROM';
		progressPercent = null;
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
				if (progress.phase === 'loading-model') {
					progressPhase = 'LASTAR DJUPNEMODELL';
					progressPercent = progress.percent ?? null;
				} else if (progress.phase === 'loading-runtime') {
					progressPhase = 'KLARGJER MOTOR';
					progressPercent = progress.percent ?? null;
				} else if (progress.phase === 'starting') {
					progressPhase = 'STARTAR MODELL';
					progressPercent = null;
				} else {
					progressPhase = 'REKNAR DJUPN';
					progressPercent = null;
				}
				announcement = progressPercent === null ? progressPhase : `${progressPhase}, ${progressPercent} prosent.`;
			});
			if (disposed || id !== generation) return;
			progressPhase = 'PLASSERER PUNKT';
			progressPercent = null;
			const cloud = imageToPointCloud({ rgba: pixels.data, width: pixels.width, height: pixels.height,
				depth: prediction.depth, depthWidth: prediction.width, depthHeight: prediction.height,
				stride: pointStride(pixels.width, pixels.height) });
			const { PointCloudViewer } = await import('../lib/pointcloud/viewer.mjs');
			if (disposed || id !== generation) return;
			mode = 'done';
			await tick();
			if (disposed || id !== generation || !cloudHost) return;
			viewer = new PointCloudViewer(cloudHost, cloud, (error: Error) => fail(error, id));
			cloudCount = cloud.count;
			viewer.setStyle(visualStyle);
			viewer.setPointSize(pointSize);
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
		progressPercent = null;
		visualStyle = 'color';
		pointSize = 1;
		mode = 'camera';
		announcement = '';
		await tick();
		void startCamera();
	}

	function setStyle(style: 'color' | 'silver' | 'depth') {
		visualStyle = style;
		viewer?.setStyle(style);
	}

	function changePointSize() {
		pointSize = pointSize >= 1.6 ? 0.7 : pointSize >= 1 ? 1.6 : 1;
		viewer?.setPointSize(pointSize);
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
	<meta name="apple-mobile-web-app-title" content="entropi" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
	<link rel="apple-touch-startup-image" href="/splash/1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
	<link rel="apple-touch-startup-image" href="/splash/1179x2556.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
	<link rel="apple-touch-startup-image" href="/splash/1206x2622.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
	<link rel="apple-touch-startup-image" href="/splash/1290x2796.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
	<link rel="apple-touch-startup-image" href="/splash/1320x2868.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
	<link rel="apple-touch-startup-image" href="/splash/1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
	<meta name="description" content="Ta eit bilete og sjå det som ei farga 3D-punktsky. Biletet blir handsama lokalt på telefonen." />
</svelte:head>

<main class="studio" class:result={mode === 'done'}>
	<div class="visual">
		<video bind:this={video} class:hidden={mode !== 'camera'} autoplay muted playsinline></video>
		{#if capturedUrl && mode !== 'done'}
			<img class="source-image" src={capturedUrl} alt="Kamerabiletet som blir rekonstruert" />
		{/if}
		<div class="cloud" class:hidden={mode !== 'done'} bind:this={cloudHost}></div>
		{#if mode === 'done' && showOriginal && capturedUrl}
			<img class="original-preview" src={capturedUrl} alt="Originalbiletet" />
		{/if}
		<div class="vignette" aria-hidden="true"></div>
		{#if mode === 'camera'}
			<div class="finder" aria-hidden="true">
				<i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>
				<div class="finder-center"><span></span><span></span></div>
			</div>
		{/if}
	</div>

	<header class="topbar">
		<div class="identity">
			<span class="wordmark">ENTROPI<span class="period">.</span></span>
			<span class="edition">SPATIAL CAMERA / 001</span>
		</div>
		<div class="live-indicator" aria-live="off">
			<span class:online={mode === 'camera' && cameraReady} class="status-dot"></span>
			<span>{mode === 'camera' ? (cameraReady ? 'LIVE' : 'KAMERA') : mode === 'working' ? 'PROCESSING' : mode === 'done' ? '3D SPACE' : 'PAUSED'}</span>
		</div>
	</header>

	{#if mode === 'camera'}
		<div class="capture-copy">
			<span class="eyebrow">01 / CAPTURE</span>
			<p>Eitt bilete.<br />Eit nytt perspektiv.</p>
		</div>
		<div class="bottom-dock capture-dock">
			<button class="dock-icon" type="button" aria-label="Vel eit bilete frå telefonen" onclick={openCapture}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 3-3 4 4" /></svg>
			</button>
			<div class="shutter-wrap">
				<button class="capture" type="button" aria-label="Ta bilete og lag 3D-punktsky" onclick={takePhoto}>
					<span class="shutter-ring"><span class="shutter-core"></span></span>
				</button>
				<span class="shutter-label">CAPTURE</span>
			</div>
			<div class="dock-spacer" aria-hidden="true"></div>
		</div>
	{:else if mode === 'working'}
		<div class="scan-overlay" aria-hidden="true"><div class="scan-beam"></div><div class="scan-grid"></div></div>
		<div class="processing" role="status" aria-live="polite">
			<div class="processing-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
			<span class="eyebrow">02 / RECONSTRUCTION</span>
			<strong>{progressPhase}</strong>
			<div class="progress-track" class:indeterminate={progressPercent === null}>
				<span style:width={progressPercent === null ? '30%' : progressPercent + '%'}></span>
			</div>
			<p>{progressPercent === null ? 'Biletet vert omsett til rom.' : progressPercent + ' %'}<br /><small>AI-estimert djupn · lokalt på eininga</small></p>
		</div>
		<button class="cancel-action" type="button" onclick={retake} aria-label="Avbryt berekninga">
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18" /></svg><span>AVBRYT</span>
		</button>
	{:else if mode === 'done'}
		<div class="result-label">
			<span class="eyebrow">03 / SPATIAL STUDY</span>
			<span class="result-number">{cloudCount.toLocaleString('nb-NO')} POINTS</span>
		</div>
		<div class="view-controls" role="group" aria-label="Utsjånad på punktskyen">
			<button class:active={visualStyle === 'color'} aria-pressed={visualStyle === 'color'} onclick={() => setStyle('color')}>RGB</button>
			<button class:active={visualStyle === 'silver'} aria-pressed={visualStyle === 'silver'} onclick={() => setStyle('silver')}>FORM</button>
			<button class:active={visualStyle === 'depth'} aria-pressed={visualStyle === 'depth'} onclick={() => setStyle('depth')}>DEPTH</button>
		</div>
		<div class="bottom-dock result-dock">
			<div class="result-tools">
				<button class="dock-icon" type="button" aria-label="Ta eit nytt bilete" onclick={retake}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.5 9a7 7 0 0 1 12.8-2L20 12M4 12l1.7 4A7 7 0 0 0 18.5 15" /></svg>
				</button>
				<button class="dock-icon" type="button" aria-label="Tilbakestill perspektivet" onclick={() => viewer?.reset()}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M5 5l5 5M19 19l-5-5M20 9V4h-5M4 15v5h5" /></svg>
				</button>
				<button class="dock-icon" type="button" aria-label="Endre punktstorleik" onclick={changePointSize}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="2.5" /><circle cx="20" cy="12" r="3.5" /></svg>
				</button>
			</div>
			<div class="result-tools">
				<button class="dock-icon" type="button" aria-label="Vis eller skjul originalbiletet" aria-pressed={showOriginal} onclick={() => (showOriginal = !showOriginal)}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" /></svg>
				</button>
				{#if plyUrl}
					<a class="dock-icon" href={plyUrl} download="entropi-punktsky.ply" aria-label="Last ned 3D-punktsky som PLY">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v4h16v-4" /></svg>
					</a>
				{/if}
				{#if capturedUrl}
					<a class="dock-icon" href={capturedUrl} target="_blank" rel="noopener" aria-label="Del eller lagre originalbiletet" onclick={sharePhoto}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0 5 5m-5-5L7 8M4 14v7h16v-7" /></svg>
					</a>
				{/if}
			</div>
		</div>
		<div class="result-footnote">DRAG TO ORBIT <span>·</span> PINCH TO ZOOM <span>·</span> ESTIMATED DEPTH</div>
	{:else if mode === 'error'}
		<div class="error-panel" role="alert">
			<span class="eyebrow">RECONSTRUCTION INTERRUPTED</span>
			<p>{errorMessage}</p>
			<button type="button" onclick={retry}>{capturedPixels ? 'PRØV IGJEN' : 'NYTT BILETE'} <span aria-hidden="true">↗</span></button>
		</div>
		<button class="cancel-action" type="button" onclick={retake} aria-label="Ta eit nytt bilete">
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18" /></svg><span>NYTT BILETE</span>
		</button>
	{/if}
	<input bind:this={photoInput} id="photo" type="file" accept="image/*" onchange={capture} oncancel={() => void startCamera()} />
	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
</main>
