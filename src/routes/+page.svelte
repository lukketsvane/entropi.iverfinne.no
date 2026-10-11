<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { updated } from '$app/state';
	import { DepthEstimator } from '../lib/pointcloud/estimator.mjs';
	import '../lib/pointcloud/minimal.css';
	import { stitchFrames } from '../../static/pointcloud/panorama.mjs';
	import { imageToPointCloud, pointCloudPLY, inferenceSize, pointStride } from '../../static/pointcloud/math.mjs';

	let video = $state<HTMLVideoElement | undefined>();
	let preview = $state<HTMLCanvasElement | undefined>();
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
	let visualStyle = $state<'color' | 'silver' | 'depth'>('silver');
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
	let recording = $state(false);
	let recordedCount = $state(0);
	let recordTimer: ReturnType<typeof setInterval> | undefined;
	let recordingFrames: {width:number;height:number;rgba:Uint8ClampedArray}[] = [];
	let recordBusy = false;
	let lastPointer = -1;
	let touchStart = 0;
	let lastTap = 0;
	let panoramaWorker: Worker | null = null;
	let previewAnimation = 0;
	let lastPreview = 0;
	let activePointer: number | null = null;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let tapTimer: ReturnType<typeof setTimeout> | undefined;
	let lastTap = 0;
	let recordingTimer: ReturnType<typeof setInterval> | undefined;
	let recording = $state(false);
	let recordCount = $state(0);
	let frames: Array<{width:number;height:number;rgba:Uint8ClampedArray}> = [];
	let panoramaWorker: Worker | null = null;
	let rejectPanorama: ((error: Error) => void) | null = null;
	let captureKind = $state<'single'|'panorama'>('single');
	let capturedFrames = $state(1);
	let acceptedFrames = $state(1);

	function stopRecording() {
		if (recordTimer) clearInterval(recordTimer);
		recordTimer = undefined;
		recording = false;
	}

	function stopCamera() {
		stopRecording();
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
		stopRecording();
		panoramaWorker?.terminate();
		panoramaWorker = null;
		recordingFrames = [];
		recordedCount = 0;
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
		const renderPreview = (time: number) => {
			if (disposed) return;
			previewAnimation = requestAnimationFrame(renderPreview);
			if (mode !== 'camera' || time - lastPreview < 85 || !preview || !video || video.readyState < 2) return;
			lastPreview = time;
			const ctx = preview.getContext('2d', {willReadFrequently:true});
			if (!ctx) return;
			const w=preview.width,h=preview.height,vw=video.videoWidth,vh=video.videoHeight;
			if (!vw || !vh) return;
			const crop=Math.min(vw/w,vh/h), sw=w*crop,sh=h*crop;
			try {
				ctx.drawImage(video,(vw-sw)/2,(vh-sh)/2,sw,sh,0,0,w,h);
				const image=ctx.getImageData(0,0,w,h);
				const source=image.data.slice(), dest=image.data;
				for(let y=0;y<h;y++) {
					const offset=Math.round(2.2*Math.sin(y*.058+time*.00052)+1.5*Math.sin(y*.017-time*.0003));
					for(let x=0;x<w;x++) {
						const sx=Math.max(0,Math.min(w-1,x+offset));
						const a=(y*w+sx)*4,b=(y*w+x)*4;
						const gray=source[a]*.299+source[a+1]*.587+source[a+2]*.114;
						const grain=((x*17+y*31+Math.floor(time/85)*19)%13)-6;
						const mono=Math.max(0,Math.min(255,(gray-128)*1.55+118+grain));
						dest[b]=dest[b+1]=dest[b+2]=mono;
						dest[b+3]=255;
					}
				}
				ctx.putImageData(image,0,0);
			} catch { /* Safari may temporarily pause the camera feed. */ }
		};
		previewAnimation = requestAnimationFrame(renderPreview);
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
			cancelAnimationFrame(previewAnimation);
			clearTimeout(holdTimer);
			clearTimeout(tapTimer);
			clearInterval(recordingTimer);
			panoramaWorker?.terminate();
			rejectPanorama?.(new Error('Avbrote.'));
			panoramaWorker=null; rejectPanorama=null;
			frames=[];
			window.removeEventListener('focus', resume);
			document.removeEventListener('visibilitychange', resume);
			estimator.dispose();
			stopCamera();
			clearCapture();
		};
	});

	function canvasFor(source: CanvasImageSource, width: number, height: number, maxSide = 840) {
		const scale = Math.min(1, maxSide / Math.max(width, height));
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

	function sampleVideo() {
		if (recordBusy || !video || video.readyState < 2 || !video.videoWidth || recordingFrames.length >= 24) return;
		recordBusy = true;
		try {
			const scale = Math.min(1, 360 / Math.max(video.videoWidth, video.videoHeight));
			const width = Math.max(24, Math.round(video.videoWidth * scale));
			const height = Math.max(24, Math.round(video.videoHeight * scale));
			const canvas = document.createElement('canvas');
			canvas.width = width; canvas.height = height;
			const context = canvas.getContext('2d', {willReadFrequently:true});
			if (!context) return;
			context.drawImage(video,0,0,width,height);
			const rgba = context.getImageData(0,0,width,height).data;
			recordingFrames.push({width,height,rgba});
			recordedCount = recordingFrames.length;
		} finally { recordBusy = false; }
	}

	function beginHold(event: PointerEvent) {
		if (mode !== 'camera' || recording || !video || video.readyState < 2) return;
		event.preventDefault();
		lastPointer = event.pointerId;
		touchStart = performance.now();
		recordingFrames = [];
		recordedCount = 0;
		recording = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		sampleVideo();
		recordTimer = setInterval(sampleVideo, 240);
	}

	async function endHold(event: PointerEvent) {
		if (!recording || event.pointerId !== lastPointer) return;
		stopRecording();
		lastPointer = -1;
		const frames = recordingFrames;
		recordingFrames = [];
		const duration = performance.now() - touchStart;
		if (duration < 350 || frames.length < 2) {
			void takePhoto();
			return;
		}
		const id = ++generation;
		mode = 'working';
		announcement = 'Set saman panorama.';
		progressPhase = 'SET SAMAN';
		progressPercent = null;
		stopCamera();
		try {
			const result = await new Promise<{width:number;height:number;rgba:Uint8ClampedArray;accepted:number}>((resolve,reject) => {
				const worker = new Worker('/pointcloud/panorama-worker.mjs', {type:'module'});
				panoramaWorker = worker;
				const timer = setTimeout(() => {
					worker.terminate();
					reject(new Error('Panoramaet tok for lang tid.'));
				}, 45000);
				worker.onmessage = (message) => {
					clearTimeout(timer);
					worker.terminate();
					if (panoramaWorker === worker) panoramaWorker = null;
					if (message.data.type === 'error') reject(new Error(message.data.message));
					else resolve({...message.data,rgba:new Uint8ClampedArray(message.data.rgba)});
				};
				worker.onerror = () => {
					clearTimeout(timer); worker.terminate();
					if (panoramaWorker === worker) panoramaWorker = null;
					reject(new Error('Panoramaet kunne ikkje setjast saman.'));
				};
				worker.postMessage({frames:frames.map(f=>({width:f.width,height:f.height,rgba:f.rgba.buffer}))},
					frames.map(f=>f.rgba.buffer));
			});
			if (disposed || id !== generation) return;
			const canvas = document.createElement('canvas');
			canvas.width=result.width; canvas.height=result.height;
			const context=canvas.getContext('2d');
			if (!context) throw new Error('Kunne ikkje vise panoramaet.');
			context.putImageData(new ImageData(result.rgba,result.width,result.height),0,0);
			const capture=canvasFor(canvas,result.width,result.height);
			await saveCapture(capture.canvas,capture.pixels,id);
		} catch(error) { fail(error,id); }
	}

	function cancelHold(event: PointerEvent) {
		if (event.pointerId !== lastPointer) return;
		stopRecording();
		recordingFrames = [];
		lastPointer = -1;
	}

	function resultTap(event: MouseEvent) {
		const now = performance.now();
		if (now - lastTap < 350) {
			lastTap = 0;
			void retake();
			return;
		}
		lastTap = now;
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
				captureKind = 'single'; capturedFrames=1; acceptedFrames=1;
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
			viewer.setStyle('silver');
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
		visualStyle = 'silver';
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
	<meta name="description" content="Ta eit bilete og sjå det som ei farga 3D-punktsky. Biletet blir handsama lokalt på telefonen." />
</svelte:head>

<main class="void-stage" class:has-cloud={mode === 'done'}>
	{#if mode === 'camera'}
		<button
			type="button"
			class="tiny-viewfinder"
			class:recording
			aria-label="Trykk for eitt bilete. Hald inne og panorer for panorama."
			onpointerdown={beginHold}
			onpointerup={endHold}
			onpointercancel={cancelHold}
			onlostpointercapture={cancelHold}
			oncontextmenu={(event) => event.preventDefault()}
		>
			<video bind:this={video} autoplay muted playsinline></video>
			<span class="analogue-noise" aria-hidden="true"></span>
			<span class="reticle" aria-hidden="true"></span>
			{#if recording}
				<span class="record-pulse" aria-hidden="true"></span>
			{/if}
		</button>
		<button type="button" class="invisible-picker" aria-label="Vel eit bilete" onclick={openCapture}></button>
	{:else if mode === 'working'}
		<div class="tiny-activity" aria-hidden="true"><span></span><span></span><span></span></div>
		{#if capturedUrl}<img class="ghost-frame" src={capturedUrl} alt="" />{/if}
		<button type="button" class="invisible-cancel" aria-label="Avbryt og gå tilbake til kameraet" onclick={retake}></button>
	{:else if mode === 'done'}
		<div class="cloud-immersive" bind:this={cloudHost} role="img" aria-label="Interaktiv tredimensjonal punktsky. Dra for å rotere og knip for å zoome."></div>
		<button type="button" class="invisible-reset" aria-label="Nytt bilete" ondblclick={() => void retake()} onclick={resultTap}></button>
		{#if plyUrl}<a class="invisible-export" href={plyUrl} download="entropi-punktsky.ply" aria-label="Last ned punktsky som PLY"></a>{/if}
	{:else}
		<button type="button" class="tiny-error" aria-label="Prøv igjen" onclick={retry}><span aria-hidden="true"></span></button>
	{/if}
	<input bind:this={photoInput} type="file" accept="image/*" onchange={capture} oncancel={() => void startCamera()} />
	<span class="sr-only" role="status" aria-live="polite">{announcement || errorMessage}</span>
</main>
