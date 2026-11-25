<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { updated } from '$app/state';
	import { DepthEstimator } from '../lib/pointcloud/estimator.mjs';
	import { attachEdgeQualitySlider } from '../lib/pointcloud/edge-quality-slider';
	import { Viewfinder } from '../lib/pointcloud/viewfinder.mjs';
	import { FrameRecorder } from '../lib/pointcloud/recorder.mjs';
	import { ShakeToClear } from '../lib/pointcloud/shake.mjs';
	import { PX10Printer } from '../lib/print/printer.mjs';
	import { artPrintJob } from '../lib/print/cloud-raster.mjs';
	import { normalizeDepth, prepareToneDepth, VATHOGRAPHY_PRESETS } from '../lib/vathography.mjs';
	import { estimateImageDepth } from '../../static/pointcloud/tiles.mjs';
	import { captureSnapshot } from '../../static/pointcloud/panorama.mjs';
	import '../lib/pointcloud/studio.css';

	type Pixels = { data: Uint8ClampedArray; width: number; height: number };
	let video: HTMLVideoElement;
	let finder: HTMLCanvasElement;
	let photoInput: HTMLInputElement;
	let art: HTMLCanvasElement;
	let stream: MediaStream | null = null;
	let preview: Viewfinder | null = null;
	let printer: PX10Printer | null = null;
	let shake: ShakeToClear | null = null;
	let presetSlider: ReturnType<typeof attachEdgeQualitySlider> | null = null;
	let printSession = '';
	let captureJobId = '';
	let manualPrint = 0;
	let pendingTaps: Pixels[] = [];
	let tapTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressCaptureClick = false;
	let printerAnnouncement = $state('');
	const estimator = new DepthEstimator();
	let mode = $state<'camera' | 'recording' | 'working' | 'done' | 'error'>('camera');
	let preset = $state(1);
	let presetActive = $state(false);
	let position = $state(0);
	let bandWidth = 1;
	let announcement = $state('Trykk for eit djupnebilete. Hald inne medan du panorerer, og slepp for eit panorama.');
	let progress = $state<number | null>(null);
	let captured: Pixels | null = null;
	let tone: ReturnType<typeof prepareToneDepth> | null = null;
	let paintFrame = 0;
	let disposed = false;
	let generation = 0;
	let cameraAttempt = 0;
	let capturePointer: number | null = null;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let panoramaWorker: Worker | null = null;
	let rejectPanorama: ((error: unknown) => void) | null = null;
	let lastTap: { time: number; x: number; y: number } | null = null;
	let artGesture: { id: number; time: number; x: number; y: number; moved: boolean } | null = null;
	const artPointers = new Map<number, { x: number; y: number }>();
	let pinchGap = 0;

	function stopCamera() {
		cameraAttempt++;
		stream?.getTracks().forEach(track => track.stop());
		stream = null;
		if (video) video.srcObject = null;
	}
	function clearResult() {
		tone = null;
		cancelAnimationFrame(paintFrame); paintFrame = 0;
		artPointers.clear(); artGesture = null; pinchGap = 0;
	}
	function paint() {
		cancelAnimationFrame(paintFrame); paintFrame = 0;
		if (!tone || !captured || !art) return;
		const { data, width, height } = captured;
		const pixels = tone({ preset, position, width: bandWidth, outputWidth: width, outputHeight: height });
		// Panorama areas without a photographed view stay black.
		for (let i = 3; i < pixels.length; i += 4) if (data[i] < 128) pixels[i - 3] = pixels[i - 2] = pixels[i - 1] = 0;
		if (art.width !== width || art.height !== height) { art.width = width; art.height = height; }
		art.getContext('2d')?.putImageData(new ImageData(pixels, width, height), 0, 0);
	}
	function schedulePaint() {
		if (!paintFrame) paintFrame = requestAnimationFrame(paint);
	}
	function selectPreset(level: number) {
		preset = level;
		presetSlider?.setLevel(level);
		try { window.localStorage?.setItem('entropi-vatho', String(level)); } catch {}
		announcement = `Uttrykk: ${VATHOGRAPHY_PRESETS[level].label}.`;
		if (mode === 'done') schedulePaint();
	}
	function setPosition(next: number) {
		position = Math.max(-1, Math.min(1, next));
		if (mode === 'done') schedulePaint();
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
		if (mode !== 'camera' || printer?.choosing || choosePrinter() || shake?.requestFromGesture()) return;
		stopCamera(); preview?.clear(); photoInput?.click();
	}
	function choosePrinter() {
		if (!printer?.needsChoice) return false;
		void printer.choose();
		return true;
	}
	async function startCamera() {
		if (disposed || document.hidden || mode !== 'camera' || stream || !video || !navigator.mediaDevices?.getUserMedia) return;
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
	function pixelsFor(source: CanvasImageSource, width: number, height: number, edge = 960): Pixels {
		const scale = Math.min(1, edge / Math.max(width, height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error('Kunne ikkje lese biletet.');
		context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(source, 0, 0, canvas.width, canvas.height);
		return captureSnapshot(context.getImageData(0, 0, canvas.width, canvas.height));
	}
	function clearTapBatch() {
		clearTimeout(tapTimer); tapTimer = undefined; pendingTaps = [];
	}
	function scheduleTapBatch() {
		clearTimeout(tapTimer);
		tapTimer = setTimeout(() => {
			tapTimer = undefined;
			if (recorder.active) return;
			const frames = pendingTaps; pendingTaps = [];
			if (frames.length && !disposed && mode === 'camera') void finishCapture(frames);
		}, 400);
	}
	function addTap(frame: Pixels) {
		pendingTaps.push(frame);
		scheduleTapBatch();
	}
	const recorder = new FrameRecorder({
		capture: () => video?.readyState >= 2 && video.videoWidth ? pixelsFor(video, video.videoWidth, video.videoHeight) : null,
		onHold: () => { mode = 'recording'; announcement = 'Samlar bilete. Panorer langsamt med overlapp, og slepp når du er ferdig.'; },
		finish: frames => {
			capturePointer = null;
			if (mode === 'recording' || frames.length > 1) {
				const combined = [...pendingTaps, ...frames]; clearTapBatch();
				void finishCapture(combined);
			} else if (frames[0]) addTap(frames[0]);
			else if (pendingTaps.length) scheduleTapBatch();
			else openCapture();
		},
		cancel: () => {
			capturePointer = null;
			if (mode === 'recording') mode = 'camera';
			if (pendingTaps.length) scheduleTapBatch();
		}
	});
	function beginCapture(event: PointerEvent) {
		if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || mode !== 'camera') return;
		if (printer?.choosing) return;
		if (choosePrinter() || shake?.requestFromGesture()) { event.preventDefault(); suppressCaptureClick = true; return; }
		if (!video || video.readyState < 2 || !video.videoWidth) return;
		event.preventDefault();
		suppressCaptureClick = false;
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
		if (suppressCaptureClick) { suppressCaptureClick = false; return; }
		if (printer?.choosing) return;
		if (mode !== 'camera') return;
		if (choosePrinter() || shake?.requestFromGesture()) return;
		if (!video || video.readyState < 2 || !video.videoWidth) { openCapture(); return; }
		// Mouse/touch already finish on release; keyboard and assistive clicks still capture.
		if (event.detail === 0) addTap(pixelsFor(video, video.videoWidth, video.videoHeight));
	}
	function stitch(frames: Pixels[]): Promise<Pixels> {
		return new Promise((resolve, reject) => {
			const worker = new Worker('/pointcloud/panorama-worker.mjs?v=5', { type: 'module' });
			panoramaWorker = worker;
			const timer = setTimeout(() => finish(new Error('Panoramaet tok for lang tid. Prøv ei kortare rørsle.')), 60000);
			function finish(error: unknown, result?: Pixels) {
				clearTimeout(timer); worker.terminate();
				if (panoramaWorker === worker) { panoramaWorker = null; rejectPanorama = null; }
				if (error) reject(error); else if (result) resolve(result);
			}
			rejectPanorama = error => finish(error);
			worker.onmessage = ({ data }) => {
				if (data.type === 'error' || data.error) finish(new Error(data.message || data.error));
				else if (data.type !== 'result' || !Number.isInteger(data.width) || !Number.isInteger(data.height)
					|| !(data.data instanceof ArrayBuffer) || data.data.byteLength !== data.width * data.height * 4) {
					finish(new Error('Panoramaet gav eit ugyldig resultat.'));
				} else finish(null, { width: data.width, height: data.height, data: new Uint8ClampedArray(data.data) });
			};
			worker.onerror = () => finish(new Error('Kunne ikkje setje saman bileta.'));
			const input = frames.map(frame => ({ width: frame.width, height: frame.height, data: frame.data.buffer }));
			worker.postMessage(input, input.map(frame => frame.data as ArrayBuffer));
		});
	}
	async function finishCapture(frames: Pixels[], id = ++generation) {
		if (disposed || id !== generation) return;
		clearTapBatch();
		if (!frames.length) { mode = 'camera'; openCapture(); return; }
		try {
			clearResult(); progress = null; mode = 'working';
			captureJobId = `${printSession}:${id}`;
			showPixels(frames[0]); stopCamera();
			captured = { ...captureSnapshot(frames[0]), data: new Uint8ClampedArray(frames[0].data) };
			if (frames.length > 1) {
				announcement = 'Set saman panorama.';
				try { captured = await stitch(frames); }
				catch (error) { if (disposed || id !== generation) return; console.warn('Panorama registration failed:', error); }
			}
			await develop(id);
		} catch (error) { fail(error, id); }
	}
	function fail(error: unknown, id: number) {
		if (disposed || id !== generation) return;
		clearResult(); estimator.dispose(); stopCamera(); mode = 'error';
		announcement = error instanceof Error ? error.message : 'Kunne ikkje lage djupnebiletet. Trykk for å prøve igjen.';
	}
	async function develop(id: number) {
		if (disposed || id !== generation || !captured) return;
		const pixels = captured;
		mode = 'working'; progress = null;
		try {
			const prediction = await estimateImageDepth(pixels, estimator, update => {
				if (disposed || id !== generation) return;
				progress = update.percent ?? null;
				announcement = update.phase.startsWith('loading') ? 'Lastar Depth Pro 2 til eininga.' : 'Reknar djupn.';
			}, () => !disposed && id === generation);
			if (disposed || id !== generation) return;
			// Free the model's memory between photographs.
			estimator.dispose();
			tone = prepareToneDepth(normalizeDepth(prediction.depth), prediction.width, prediction.height);
			mode = 'done'; if (preview) { preview.active = false; preview.source = null; }
			await tick();
			if (disposed || id !== generation) return;
			paint();
			announcement = `${VATHOGRAPHY_PRESETS[preset].label}. Djupna er estimert med Depth Pro 2. Dra vassrett for å flytte djupneområdet, og knip for breidda. Dra langs høgre kant for fem uttrykk. Hald inne for utskrift. Dobbelttrykk for eit nytt bilete.`;
			queueCurrentPrint();
		} catch (error) { fail(error, id); }
	}
	function queueCurrentPrint(jobId = captureJobId) {
		if (!printer?.device || !tone || !art || mode !== 'done') return;
		try { printer.enqueue(jobId, artPrintJob(art)); }
		catch { printerAnnouncement = 'Biletet er klart, men utskrifta kunne ikkje klargjerast.'; }
	}
	function printCurrent() {
		if (!tone || mode !== 'done' || !printer?.supported || printer.choosing || printer.busy) return;
		const id = generation, source = tone;
		// Invoke the native chooser in pointerup itself, even if Bluetooth was enabled after capture.
		const pairing = printer.device ? printer.start() : printer.choose();
		void pairing.then(ready => {
			if (ready && !disposed && id === generation && source === tone) queueCurrentPrint(`${captureJobId}:manual:${++manualPrint}`);
		});
	}
	function saveArt(event: MouseEvent) {
		(event.currentTarget as HTMLAnchorElement).href = art.toDataURL('image/png');
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
		clearTapBatch();
		const id = ++generation; mode = 'working'; stopCamera();
		try {
			const frames: Pixels[] = [];
			for (const file of files) {
				const decoded = await decodePhoto(file);
				try {
					if (disposed || id !== generation) return;
					frames.push(pixelsFor(decoded.source, decoded.width, decoded.height, files.length === 1 ? 1536 : 960));
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
		generation++;
		clearTapBatch();
		recorder.abort(); estimator.dispose(); stopPanorama(); clearResult(); stopCamera(); captured = null;
		captureJobId = '';
		capturePointer = null;
		progress = null; lastTap = null; mode = 'camera';
		announcement = 'Trykk for eit djupnebilete. Hald inne for panorama.';
		if (photoInput) photoInput.value = '';
		if (preview) { preview.source = null; preview.clear(); preview.active = true; }
		await tick(); void startCamera();
	}
	function clearCanvas() {
		// A lifted finger after a shake must not capture the discarded frames again.
		if (capturePointer !== null || artGesture !== null) suppressCaptureClick = true;
		// A released shutter has already committed its print; clearing only resets the draft/view.
		void retake();
	}
	function retry() {
		if (!captured) { void retake(); return; }
		clearResult(); void develop(++generation);
	}
	function pinchDistance() {
		const [a, b] = [...artPointers.values()];
		return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
	}
	function artDown(event: PointerEvent) {
		artPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (artPointers.size === 1 && event.isPrimary) {
			artGesture = { id: event.pointerId, time: performance.now(), x: event.clientX, y: event.clientY, moved: false };
			return;
		}
		if (artGesture) artGesture.moved = true;
		lastTap = null; pinchGap = pinchDistance();
	}
	function artMove(event: PointerEvent) {
		const last = artPointers.get(event.pointerId);
		if (!last) return;
		const next = { x: event.clientX, y: event.clientY };
		artPointers.set(event.pointerId, next);
		if (mode !== 'done') return;
		if (artPointers.size === 1 && artGesture?.id === event.pointerId) {
			if (!artGesture.moved && Math.hypot(next.x - artGesture.x, next.y - artGesture.y) <= 12) return;
			artGesture.moved = true;
			setPosition(position + (next.x - last.x) / Math.max(1, art?.clientWidth || 1));
		} else if (artPointers.size === 2) {
			const distance = pinchDistance();
			if (pinchGap > 0 && distance > 0) { bandWidth = Math.max(.25, Math.min(3, bandWidth * distance / pinchGap)); schedulePaint(); }
			pinchGap = distance;
		}
	}
	function artUp(event: PointerEvent) {
		artPointers.delete(event.pointerId);
		pinchGap = pinchDistance();
		const start = artGesture;
		if (!start || start.id !== event.pointerId) return;
		artGesture = null;
		if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) { lastTap = null; return; }
		const held = performance.now() - start.time;
		if (held >= 500) { lastTap = null; printCurrent(); return; }
		if (held > 250) return;
		const tap = { time: performance.now(), x: event.clientX, y: event.clientY };
		if (lastTap && tap.time - lastTap.time < 360 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 28) void retake();
		else lastTap = tap;
	}
	function artCancel(event: PointerEvent) {
		artPointers.delete(event.pointerId); pinchGap = pinchDistance();
		if (artGesture?.id === event.pointerId) artGesture = null;
	}
	function keys(event: KeyboardEvent) {
		if (event.key === 'Escape') void retake();
	}
	onMount(() => {
		printSession = globalThis.crypto?.randomUUID() ?? `${Date.now()}-${Math.random()}`;
		try {
			const saved = window.localStorage?.getItem('entropi-vatho');
			if (saved && /^[0-4]$/.test(saved)) preset = Number(saved);
		} catch {}
		presetSlider = attachEdgeQualitySlider(window, {levels: VATHOGRAPHY_PRESETS.length, initialLevel: preset, onLevel: selectPreset,
			onActive: active => { presetActive = active; }});
		shake = new ShakeToClear({ target: window, hasDraft: () => recorder.active || pendingTaps.length > 0 || mode !== 'camera', clear: clearCanvas });
		shake.start();
		printer = new PX10Printer();
		const printStatus = (event: Event) => {
			const state = (event as CustomEvent).detail.state as string;
			printerAnnouncement = ({ choosing: 'Vel PX10 i Bluetooth-dialogen.', connecting: 'Koplar til skrivaren.',
				connected: 'Skrivaren er klar. Trykk for bilete, hald inne for panorama.', reconnecting: 'Koplar til skrivaren att.',
				sending: 'Skriv ut djupnebiletet.', sent: 'Djupnebiletet er sendt til skrivaren.',
				cancelled: 'Kameraet kan brukast utan utskrift.', failed: 'Utskrifta stoppa. Kameraet og djupnebiletet er framleis tilgjengelege.' } as Record<string, string>)[state] ?? '';
		};
		printer.addEventListener('status', printStatus);
		const restorePrinter = () => { if (!document.hidden) void printer?.start(); };
		// Listen for late Safari-extension injection without loading a third-party SDK.
		window.addEventListener('beacio:ready', restorePrinter);
		window.addEventListener('beacio:extension:ready', restorePrinter);
		const printerChecks = [0, 300, 1200, 3000].map(delay => setTimeout(restorePrinter, delay));
		try { preview = new Viewfinder(finder); } catch { announcement = 'Kamerasøkjaren kunne ikkje startast. Trykk for å velje eit bilete.'; }
		void startCamera();
		const suspend = () => {
			clearTimeout(resumeTimer); clearTapBatch(); recorder.abort(); stopCamera();
			shake?.suspend();
			printer?.suspend();
			if (mode === 'camera') preview?.clear();
		};
		const resume = () => {
			clearTimeout(resumeTimer);
			if (document.visibilityState !== 'visible') { suspend(); return; }
			shake?.start();
			restorePrinter();
			if (updated.current && mode === 'camera') { location.reload(); return; }
			resumeTimer = setTimeout(() => {
				if (mode !== 'camera') return;
				if (stream && !stream.getVideoTracks().some(track => track.readyState === 'live')) stopCamera();
				void startCamera();
			}, 300);
		};
		window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
		window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume);
		return () => {
			disposed = true; generation++; clearTimeout(resumeTimer); clearTapBatch(); recorder.abort();
			presetSlider?.dispose(); presetSlider = null;
			shake?.dispose(); shake = null;
			window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume);
			window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
			window.removeEventListener('beacio:ready', restorePrinter); window.removeEventListener('beacio:extension:ready', restorePrinter);
			printerChecks.forEach(clearTimeout); printer?.removeEventListener('status', printStatus); printer?.dispose(); printer = null;
			estimator.dispose(); stopPanorama(); stopCamera(); preview?.dispose(); clearResult(); captured = null;
		};
	});
</script>

<svelte:head>
	<title>entropi</title>
	<meta name="description" content="Eit stille djupnekamera. Trykk for eit bilete, og Depth Pro 2 framkallar det som djupnelitografi." />
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
		<button class="capture-plane" type="button" aria-label="Trykk for eit djupnebilete og utskrift. Hald inne for panorama. Dra ein finger langs høgre kant for fem djupneuttrykk. Rist for å tømme lerretet. Dei første trykka gir systemløyve når det trengst."
			onpointerdown={beginCapture} onpointerup={endCapture} onpointercancel={cancelCapture} onlostpointercapture={cancelCapture} oncontextmenu={event => event.preventDefault()} onclick={captureClick}></button>
		<button class="access-control" type="button" aria-label="Vel bilete frå telefonen" onclick={openCapture}><i class="plus" aria-hidden="true"></i></button>
	{:else if mode === 'working'}
		<button class="capture-plane" type="button" aria-label="Dobbelttrykk for å avbryte berekninga" onpointerdown={artDown} onpointerup={artUp} onpointercancel={artCancel}></button>
		<button class="access-control" type="button" aria-label="Avbryt berekninga" onclick={retake}><i class="plus close" aria-hidden="true"></i></button>
	{:else if mode === 'error'}
		<button class="retry-plane" type="button" aria-label="Prøv igjen" onclick={retry}><i class="retry-mark" aria-hidden="true"></i></button>
	{/if}
	<div class="cloud art" class:hidden={mode !== 'done'} onpointerdown={artDown} onpointermove={artMove} onpointerup={artUp} onpointercancel={artCancel} oncontextmenu={event => event.preventDefault()} role="img" aria-label="Djupnelitografi. Dra vassrett for å flytte djupneområdet, og knip med to fingrar for breidda. Dra ein finger langs høgre kant for fem uttrykk. Hald inne utan å flytte fingeren for utskrift. Rist for å tømme lerretet. Dobbelttrykk for eit nytt bilete.">
		<canvas bind:this={art}></canvas>
	</div>
	<div class="quality-rail" class:active={presetActive} aria-hidden="true">
		{#each [4, 3, 2, 1, 0] as level, index}<i class:chosen={preset === level} style:top={`${index * 20 + 10}%`}></i>{/each}
	</div>
	{#if mode === 'done'}
		<button class="access-control" type="button" aria-label="Ta eit nytt bilete" onclick={retake}><i class="plus" aria-hidden="true"></i></button>
		<a class="access-control download" href="/" download="entropi-djupn.png" aria-label="Last ned djupnebiletet" onclick={saveArt}><i class="download-mark" aria-hidden="true"></i></a>
	{/if}
	<input bind:this={photoInput} type="file" accept="image/*" multiple onchange={capture} oncancel={() => void startCamera()} tabindex="-1" aria-label="Kamerabilete" />
	<input class="sr-only" type="range" min="0" max="4" step="1" value={preset} aria-label="Djupneuttrykk" aria-valuetext={VATHOGRAPHY_PRESETS[preset].label} oninput={event => selectPreset(Number(event.currentTarget.value))} />
	<input class="sr-only" type="range" min="-1" max="1" step="0.02" value={position} aria-label="Djupneområde" oninput={event => setPosition(Number(event.currentTarget.value))} />
	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
	<span class="sr-only" role="status" aria-live="polite">{printerAnnouncement}</span>
</main>
