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
	import { createGallery } from '../lib/gallery.mjs';
	import { LOOKS, finishArt, photoDetail } from '../lib/finish.mjs';
	import { estimateImageDepth } from '../../static/pointcloud/tiles.mjs';
	import { captureSnapshot } from '../../static/pointcloud/panorama.mjs';
	import '../lib/pointcloud/studio.css';

	type Pixels = { data: Uint8ClampedArray; width: number; height: number };
	let video: HTMLVideoElement;
	let finder: HTMLCanvasElement;
	let photoInput: HTMLInputElement;
	let uploadInput: HTMLInputElement;
	let art: HTMLCanvasElement;
	let stream: MediaStream | null = null;
	let preview: Viewfinder | null = null;
	let printer: PX10Printer | null = null;
	let shake: ShakeToClear | null = null;
	let presetSlider: ReturnType<typeof attachEdgeQualitySlider> | null = null;
	let lookSlider: ReturnType<typeof attachEdgeQualitySlider> | null = null;
	let printSession = '';
	let captureJobId = '';
	let manualPrint = 0;
	let pendingTaps: Pixels[] = [];
	let sharpTap: Pixels | null = null;
	let tapTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressCaptureClick = false;
	let printerAnnouncement = $state('');
	const estimator = new DepthEstimator();
	let mode = $state<'camera' | 'recording' | 'working' | 'done' | 'error'>('camera');
	let preset = $state(1);
	let presetActive = $state(false);
	let position = $state(0);
	let bandWidth = 1;
	let contrast = $state(1);
	let gamma = $state(1);
	let look = $state(0);
	let lookActive = $state(false);
	let strength = $state(1);
	let structure = $state(0);
	let sharpen = $state(0);
	let grain = $state(0);
	let detail: Float32Array | null = null;
	let level = $state<number | null>(null);
	let levelTimer: ReturnType<typeof setTimeout> | undefined;
	let selecting = $state(false);
	let selected = $state<string[]>([]);
	let preparedIds = $state<string[]>([]);
	let selectionArmed = $state(false);
	const prepared = new Map<string, File>();
	let preparing = false;
	let announcement = $state('Trykk for eit djupnebilete. Hald inne medan du panorerer, og slepp for eit panorama.');
	let progress = $state<number | null>(null);
	let captured: Pixels | null = null;
	let tone: ReturnType<typeof prepareToneDepth> | null = null;
	let frame: { width: number; height: number; mask: Uint8Array | null } | null = null;
	const gallery = createGallery();
	let galleryOpen = $state(false);
	let galleryItems = $state<{ id: string; created: number; url: string }[]>([]);
	let currentId: string | null = null;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let uploading = $state(0);
	let uploadsRunning = false;
	let menu = $state<{ id: string; file: File | null; armed: boolean; x: number; y: number } | null>(null);
	let press: { id: string; pointerId: number; x: number; y: number; rect: DOMRect; timer: ReturnType<typeof setTimeout> } | null = null;
	let pressed = false;
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;
	const shareable = (files: File[]) => typeof navigator.share === 'function' && !!navigator.canShare?.({ files });
	const canShareFiles = (file: File) => shareable([file]);
	let depthBusy = false;
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	const depthWaiters: { priority: number; resolve: () => void }[] = [];
	let paintFrame = 0;
	let disposed = false;
	let generation = 0;
	let cameraAttempt = 0;
	let capturePointer: number | null = null;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let panoramaWorker: Worker | null = null;
	let rejectPanorama: ((error: unknown) => void) | null = null;
	let lastTap: { time: number; x: number; y: number } | null = null;
	let artGesture: { id: number; time: number; x: number; y: number; moved: boolean; axis: 'x' | 'y' | null } | null = null;
	const artPointers = new Map<number, { x: number; y: number }>();
	type Pair = { cx: number; cy: number; distance: number; angle: number };
	let twoFinger: { mode: 'pending' | 'pinch' | 'rotate' | 'panX' | 'panY'; start: Pair; last: Pair; time: number; turned: number } | null = null;
	type Spread = { cx: number; cy: number; spread: number };
	let threeFinger: { mode: 'pending' | 'pinch' | 'panX' | 'panY'; start: Spread; last: Spread } | null = null;
	let lastTwoTap = 0;

	/** One depth model at a time: a photograph goes ahead of queued uploads, and nothing cancels the other. */
	async function withDepth<T>(priority: number, task: () => Promise<T>): Promise<T> {
		clearTimeout(releaseTimer);
		if (depthBusy) await new Promise<void>(resolve => { depthWaiters.push({ priority, resolve }); depthWaiters.sort((a, b) => b.priority - a.priority); });
		depthBusy = true;
		try { return await task(); }
		finally {
			const next = depthWaiters.shift();
			if (next) next.resolve();
			else {
				depthBusy = false;
				// Keep the model warm for the next image, then give its memory back.
				releaseTimer = setTimeout(() => { if (!depthBusy) estimator.dispose(); }, 20000);
			}
		}
	}

	function stopCamera() {
		cameraAttempt++;
		stream?.getTracks().forEach(track => track.stop());
		stream = null;
		if (video) video.srcObject = null;
	}
	function clearResult() {
		if (saveTimer) { if (paintFrame) paint(); saveTone(); }
		tone = null; frame = null; currentId = null; detail = null;
		cancelAnimationFrame(paintFrame); paintFrame = 0;
		artPointers.clear(); artGesture = null; twoFinger = null; threeFinger = null;
	}
	function paint() {
		cancelAnimationFrame(paintFrame); paintFrame = 0;
		if (!tone || !frame || !art) return;
		renderArt(art, tone, frame, recipe(), detail);
	}
	type Frame = { width: number; height: number; mask: Uint8Array | null };
	type Recipe = ReturnType<typeof recipe>;
	function renderArt(canvas: HTMLCanvasElement, render: ReturnType<typeof prepareToneDepth>, target: Frame, values: Partial<Recipe>, texture: Float32Array | null = null) {
		const { width, height, mask } = target;
		const pixels = render({ ...values, outputWidth: width, outputHeight: height });
		finishArt(pixels, width, height, values, texture);
		// Panorama areas without a photographed view stay black.
		if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = 0;
		if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
		canvas.getContext('2d')?.putImageData(new ImageData(pixels, width, height), 0, 0);
	}
	function schedulePaint() {
		if (!paintFrame) paintFrame = requestAnimationFrame(paint);
		if (currentId) { clearTimeout(saveTimer); saveTimer = setTimeout(saveTone, 600); }
	}
	function saveTone() {
		clearTimeout(saveTimer); saveTimer = undefined;
		const id = currentId, values = recipe();
		if (id) void thumbnail().then(image => gallery.update(id, values, image)).catch(() => {});
	}
	function recipe() {
		return { preset, position, width: bandWidth, contrast, gamma, look, strength, structure, sharpen, grain };
	}
	function applyRecipe(values: Partial<Recipe>) {
		preset = values.preset ?? preset; presetSlider?.setLevel(preset);
		look = values.look ?? 0; lookSlider?.setLevel(look);
		position = values.position ?? 0; bandWidth = values.width ?? 1; contrast = values.contrast ?? 1; gamma = values.gamma ?? 1;
		strength = values.strength ?? 1; structure = values.structure ?? 0; sharpen = values.sharpen ?? 0; grain = values.grain ?? 0;
	}
	function showLevel(value: number) {
		level = Math.max(0, Math.min(1, value));
		clearTimeout(levelTimer); levelTimer = setTimeout(() => { level = null; }, 700);
	}
	function jpeg(pixels: Pixels): Promise<Blob | null> {
		const canvas = document.createElement('canvas');
		canvas.width = pixels.width; canvas.height = pixels.height;
		canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
		return new Promise(resolve => canvas.toBlob(blob => { canvas.width = canvas.height = 1; resolve(blob); }, 'image/jpeg', .9));
	}
	async function photoPixels(photo: Blob | undefined, width: number, height: number) {
		if (!photo) return null;
		try {
			const decoded = await decodePhoto(photo);
			try { return pixelsFor(decoded.source, width, height, Math.max(width, height)); } finally { decoded.close(); }
		} catch { return null; }
	}
	/** The finished image of a gallery item at full size, with the photograph's structure when it was kept. */
	async function itemFile(id: string) {
		const record = await gallery.get(id);
		if (!record) return null;
		const pixels = await photoPixels(record.photo, record.width, record.height);
		const canvas = document.createElement('canvas');
		renderArt(canvas, prepareToneDepth(Float32Array.from(record.depth, value => value / 65535), record.depthWidth, record.depthHeight),
			{ width: record.width, height: record.height, mask: record.mask ?? null }, record.recipe, pixels ? photoDetail(pixels.data, pixels.width, pixels.height) : null);
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
		canvas.width = canvas.height = 1;
		return blob ? new File([blob], `entropi-djupn-${id}.png`, { type: 'image/png' }) : null;
	}
	function maskFor(pixels: Pixels) {
		let mask: Uint8Array | null = null;
		for (let i = 0; i < pixels.width * pixels.height; i++) if (pixels.data[i * 4 + 3] < 128) (mask ??= new Uint8Array(pixels.width * pixels.height))[i] = 1;
		return mask;
	}
	function thumbnail(source = art): Promise<Blob | null> {
		const side = Math.min(source.width, source.height), canvas = document.createElement('canvas');
		canvas.width = canvas.height = 240;
		canvas.getContext('2d')?.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, 240, 240);
		return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .8));
	}
	async function archive(id: number, field: Float32Array, depthWidth: number, depthHeight: number, pixels: Pixels) {
		if (!frame) return;
		try {
			const photo = await jpeg(pixels) ?? undefined;
			const item = { ...frame, depth: Uint16Array.from(field, value => Math.round(value * 65535)), depthWidth, depthHeight, recipe: recipe(), photo };
			const saved = await gallery.save(item, await thumbnail());
			if (id === generation && mode === 'done') currentId = saved;
		} catch { /* The image stays usable without local storage. */ }
	}
	function releaseGallery() {
		for (const item of galleryItems) URL.revokeObjectURL(item.url);
		galleryItems = [];
	}
	async function openGallery() {
		if (galleryOpen || (mode !== 'camera' && mode !== 'done')) return;
		clearTapBatch(); recorder.abort();
		galleryOpen = true;
		if (mode === 'camera') { stopCamera(); preview?.clear(); }
		try {
			const entries = await gallery.list();
			if (!galleryOpen) return;
			galleryItems = entries.filter(entry => entry.thumbnail).map(entry => ({ id: entry.id, created: entry.created, url: URL.createObjectURL(entry.thumbnail as Blob) }));
			announcement = galleryItems.length ? `Galleri med ${galleryItems.length} djupnebilete.` : 'Galleriet er tomt.';
		} catch { announcement = 'Galleriet er ikkje tilgjengeleg i denne nettlesaren.'; }
	}
	async function queueUploads(files: File[]) {
		if (!files.length) return;
		try { await gallery.enqueue(files); } catch { announcement = 'Kunne ikkje ta vare på bileta. Prøv igjen.'; return; }
		void processUploads();
	}
	/** Develop every queued upload in turn. The queue is stored, so a reload continues where it stopped. */
	async function processUploads() {
		if (uploadsRunning || disposed) return;
		uploadsRunning = true;
		let done = 0, failed = 0;
		try {
			while (!disposed) {
				const jobs = await gallery.pending();
				uploading = jobs.length;
				const job = jobs[0];
				if (!job) break;
				try {
					const added = await developUpload(job);
					done++;
					if (added && galleryOpen) galleryItems = [added, ...galleryItems];
				} catch (error) {
					if (disposed) break;
					// Unreadable files are dropped at once; a model failure gets two more attempts.
					if ((error as Error)?.name === 'DecodeError' || job.attempts >= 2) { await gallery.drop(job.id); failed++; }
					else await gallery.retry(job);
				}
			}
		} catch { /* Storage is unavailable; queued files stay for the next start. */ }
		finally { uploadsRunning = false; uploading = 0; }
		if (done || failed) announcement = `${done} opplasta bilete lagt i galleriet.${failed ? ` ${failed} kunne ikkje lesast.` : ''}`;
	}
	async function developUpload(job: { id: string; file: Blob; name: string }) {
		let pixels: Pixels;
		try {
			const decoded = await decodePhoto(job.file);
			try { pixels = pixelsFor(decoded.source, decoded.width, decoded.height, 1536); } finally { decoded.close(); }
		} catch { throw Object.assign(new Error('Kunne ikkje lese biletet.'), { name: 'DecodeError' }); }
		const prediction = await withDepth(0, () => estimateImageDepth(pixels, estimator, () => {}));
		const field = normalizeDepth(prediction.depth), values = recipe();
		const target = { width: pixels.width, height: pixels.height, mask: maskFor(pixels) }, canvas = document.createElement('canvas');
		renderArt(canvas, prepareToneDepth(field, prediction.width, prediction.height), target, values, photoDetail(pixels.data, pixels.width, pixels.height));
		const image = await thumbnail(canvas);
		canvas.width = canvas.height = 1;
		const photo = await jpeg(pixels) ?? undefined;
		const id = await gallery.complete(job.id, { ...target, depth: Uint16Array.from(field, value => Math.round(value * 65535)), depthWidth: prediction.width, depthHeight: prediction.height, recipe: values, photo }, image);
		return image ? { id, created: Date.now(), url: URL.createObjectURL(image) } : null;
	}
	function uploadToGallery(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []); input.value = '';
		void queueUploads(files);
	}
	function tileDown(event: PointerEvent, item: { id: string; url: string }) {
		cancelPress();
		pressed = false;
		if (selecting || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		press = { id: item.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, timer: setTimeout(() => {
			press = null; pressed = true; void openMenu(item, rect);
		}, 500) };
	}
	function tileMove(event: PointerEvent) {
		if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
	}
	function cancelPress() {
		if (press) clearTimeout(press.timer);
		press = null;
	}
	function tileClick(id: string) {
		if (pressed) { pressed = false; return; }
		if (selecting) toggleSelected(id); else void openItem(id);
	}
	function toggleSelecting(id?: string) {
		closeMenu();
		selecting = id ? true : !selecting; selectionArmed = false;
		selected = id ? [id] : [];
		if (!selecting) { prepared.clear(); preparedIds = []; }
		else void prepareSelection();
		announcement = selecting ? 'Vel bilete. Trykk på bileta du vil ha med.' : 'Utval avslutta.';
	}
	function toggleSelected(id: string) {
		selected = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
		selectionArmed = false;
		announcement = `${selected.length} valt.`;
		void prepareSelection();
	}
	/** Render the full images as they are chosen, so share and save run straight from the tap. */
	async function prepareSelection() {
		if (preparing) return;
		preparing = true;
		try {
			for (let id = selected.find(item => !prepared.has(item)); id && selecting; id = selected.find(item => !prepared.has(item))) {
				const file = await itemFile(id).catch(() => null);
				if (!file) { selected = selected.filter(item => item !== id); continue; }
				prepared.set(id, file); preparedIds = [...prepared.keys()];
			}
		} finally { preparing = false; }
	}
	const selectionReady = () => selected.length > 0 && selected.every(id => preparedIds.includes(id));
	const selectionFiles = () => selected.map(id => prepared.get(id)).filter((file): file is File => !!file);
	function shareFiles(files: File[]) {
		return typeof navigator.share === 'function' && !!navigator.canShare?.({ files }) ? navigator.share({ files }).then(() => true, () => true) : null;
	}
	function saveSelection() {
		if (!selectionReady()) return;
		const files = selectionFiles();
		if (!shareFiles(files)) files.forEach(download);
	}
	function shareSelection() {
		if (selectionReady()) shareFiles(selectionFiles());
	}
	async function deleteSelection() {
		if (!selected.length) return;
		if (!selectionArmed) { selectionArmed = true; announcement = `Trykk på slett ein gong til for å slette ${selected.length} bilete.`; return; }
		const ids = selected;
		try {
			for (const id of ids) await gallery.remove(id);
			for (const item of galleryItems) if (ids.includes(item.id)) URL.revokeObjectURL(item.url);
			galleryItems = galleryItems.filter(item => !ids.includes(item.id));
			if (currentId && ids.includes(currentId)) { clearTimeout(saveTimer); saveTimer = undefined; currentId = null; }
			announcement = `${ids.length} bilete sletta.`;
		} catch { announcement = 'Kunne ikkje slette alle bileta.'; }
		toggleSelecting();
	}
	async function openMenu(item: { id: string; url: string }, rect: DOMRect) {
		clearTimeout(disarmTimer);
		// A small menu beside the held tile; the grid stays as it is.
		const x = Math.max(84, Math.min(window.innerWidth - 84, rect.left + rect.width / 2));
		const y = rect.bottom + 64 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 60);
		menu = { id: item.id, file: null, armed: false, x, y };
		try {
			const file = await itemFile(item.id);
			if (file && menu?.id === item.id) menu = { ...menu, file };
		} catch { announcement = 'Kunne ikkje klargjere biletet.'; }
	}
	function closeMenu() {
		clearTimeout(disarmTimer); menu = null;
	}
	function download(file: File) {
		const url = URL.createObjectURL(file), link = document.createElement('a');
		link.href = url; link.download = file.name; link.click();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	}
	function saveMenu() {
		const file = menu?.file;
		if (!file) return;
		// iOS only saves to Photos through the share sheet's own Save Image action.
		if (canShareFiles(file)) void navigator.share({ files: [file] }).catch(() => {});
		else download(file);
		closeMenu();
	}
	function shareMenu() {
		const file = menu?.file;
		if (!file || !canShareFiles(file)) return;
		void navigator.share({ files: [file] }).catch(() => {});
		closeMenu();
	}
	async function deleteMenu() {
		const current = menu;
		if (!current) return;
		if (!current.armed) {
			menu = { ...current, armed: true };
			announcement = 'Trykk på slett ein gong til for å slette biletet.';
			disarmTimer = setTimeout(() => { if (menu?.id === current.id) menu = { ...menu, armed: false }; }, 3000);
			return;
		}
		closeMenu();
		try {
			await gallery.remove(current.id);
			const removed = galleryItems.find(item => item.id === current.id);
			if (removed) URL.revokeObjectURL(removed.url);
			galleryItems = galleryItems.filter(item => item.id !== current.id);
			if (currentId === current.id) { clearTimeout(saveTimer); saveTimer = undefined; currentId = null; }
			announcement = 'Biletet er sletta.';
		} catch { announcement = 'Kunne ikkje slette biletet.'; }
	}
	function closeGallery() {
		if (!galleryOpen) return;
		cancelPress(); closeMenu();
		if (selecting) toggleSelecting();
		galleryOpen = false; releaseGallery();
		if (mode === 'camera') void startCamera();
	}
	async function openItem(id: string) {
		const opening = ++generation;
		cancelPress(); closeMenu();
		try {
			const item = await gallery.get(id);
			if (!item || disposed || opening !== generation) return;
			clearTapBatch(); recorder.abort(); stopPanorama(); clearResult(); stopCamera();
			captured = null; captureJobId = ''; progress = null; lastTap = null;
			frame = { width: item.width, height: item.height, mask: item.mask ?? null };
			tone = prepareToneDepth(Float32Array.from(item.depth, value => value / 65535), item.depthWidth, item.depthHeight);
			applyRecipe(item.recipe);
			const pixels = await photoPixels(item.photo, item.width, item.height);
			if (disposed || opening !== generation) return;
			detail = pixels ? photoDetail(pixels.data, pixels.width, pixels.height) : null;
			currentId = id; mode = 'done';
			galleryOpen = false; releaseGallery();
			if (preview) { preview.active = false; preview.source = null; }
			await tick();
			if (disposed || opening !== generation) return;
			paint();
			announcement = `${VATHOGRAPHY_PRESETS[preset].label}. Opna frå galleriet.`;
		} catch { announcement = 'Kunne ikkje opne biletet frå galleriet.'; }
	}
	function selectPreset(level: number) {
		preset = level;
		presetSlider?.setLevel(level);
		try { window.localStorage?.setItem('entropi-vatho', String(level)); } catch {}
		announcement = `Uttrykk: ${VATHOGRAPHY_PRESETS[level].label}.`;
		if (mode === 'done') schedulePaint();
	}
	function selectLook(level: number) {
		look = level;
		lookSlider?.setLevel(level);
		try { window.localStorage?.setItem('entropi-look', String(level)); } catch {}
		announcement = `Farge: ${LOOKS[level].label}.`;
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
		if (disposed || document.hidden || mode !== 'camera' || galleryOpen || stream || !video || !navigator.mediaDevices?.getUserMedia) return;
		const attempt = ++cameraAttempt;
		try {
			// Ask for the sensor's detail; without a size the browser often streams 640 × 480.
			const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
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
		clearTimeout(tapTimer); tapTimer = undefined; pendingTaps = []; sharpTap = null;
	}
	function sharpFrame() {
		return video?.readyState >= 2 && video.videoWidth ? pixelsFor(video, video.videoWidth, video.videoHeight, 1536) : null;
	}
	function scheduleTapBatch() {
		clearTimeout(tapTimer);
		tapTimer = setTimeout(() => {
			tapTimer = undefined;
			if (recorder.active) return;
			// A single photograph keeps the full frame; panoramas register equal-sized views.
			const frames = pendingTaps.length === 1 && sharpTap ? [sharpTap] : pendingTaps;
			pendingTaps = []; sharpTap = null;
			if (frames.length && !disposed && mode === 'camera') void finishCapture(frames);
		}, 400);
	}
	function addTap(frame: Pixels) {
		pendingTaps.push(frame);
		sharpTap = pendingTaps.length === 1 ? sharpFrame() : null;
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
		clearResult(); stopCamera(); mode = 'error';
		announcement = error instanceof Error ? error.message : 'Kunne ikkje lage djupnebiletet. Trykk for å prøve igjen.';
	}
	async function develop(id: number) {
		if (disposed || id !== generation || !captured) return;
		const pixels = captured;
		mode = 'working'; progress = null;
		try {
			const prediction = await withDepth(1, () => estimateImageDepth(pixels, estimator, update => {
				if (disposed || id !== generation) return;
				progress = update.percent ?? null;
				announcement = update.phase.startsWith('loading') ? 'Lastar Depth Pro 2 til eininga.' : 'Reknar djupn.';
			}, () => !disposed && id === generation));
			if (disposed || id !== generation) return;
			const field = normalizeDepth(prediction.depth);
			tone = prepareToneDepth(field, prediction.width, prediction.height);
			frame = { width: pixels.width, height: pixels.height, mask: maskFor(pixels) };
			detail = photoDetail(pixels.data, pixels.width, pixels.height);
			mode = 'done'; if (preview) { preview.active = false; preview.source = null; }
			await tick();
			if (disposed || id !== generation) return;
			paint();
			void archive(id, field, prediction.width, prediction.height, pixels);
			announcement = `${VATHOGRAPHY_PRESETS[preset].label}. Djupna er estimert med ${prediction.model ?? 'Depth Pro 2'}. Dra vassrett for å flytte djupneområdet, og knip for breidda. Dra langs høgre kant for fem uttrykk. Hald inne for utskrift. Dobbelttrykk for eit nytt bilete.`;
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
	async function decodePhoto(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
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
		if (galleryOpen) {
			const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
			if (files.length) { event.preventDefault(); void queueUploads(files); }
			return;
		}
		if (mode !== 'camera') return;
		const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/')).slice(0, 32);
		if (!files.length) return;
		event.preventDefault(); void captureFiles(files);
	}
	async function retake() {
		generation++;
		clearTapBatch();
		recorder.abort(); stopPanorama(); clearResult(); stopCamera(); captured = null;
		cancelPress(); closeMenu(); if (selecting) toggleSelecting(); galleryOpen = false; releaseGallery();
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
	function pair(): Pair | null {
		const [a, b] = [...artPointers.values()];
		return a && b ? { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) } : null;
	}
	const turn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
	const limit = (value: number) => Math.max(.25, Math.min(4, value));
	function resetTone() {
		position = 0; bandWidth = 1; contrast = 1; gamma = 1; strength = 1; structure = 0; sharpen = 0; grain = 0;
		announcement = 'Djupneområde, breidd, kontrast, mellomtonar, struktur, skarpleik, korn og fargestyrke er nullstilte.';
		if (mode === 'done') schedulePaint();
	}
	function artDown(event: PointerEvent) {
		artPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (artPointers.size === 1 && event.isPrimary) {
			artGesture = { id: event.pointerId, time: performance.now(), x: event.clientX, y: event.clientY, moved: false, axis: null };
			return;
		}
		if (artGesture) artGesture.moved = true;
		lastTap = null;
		const start = pair(), three = spread();
		twoFinger = artPointers.size === 2 && start ? { mode: 'pending', start, last: start, time: performance.now(), turned: 0 } : null;
		threeFinger = three ? { mode: 'pending', start: three, last: three } : null;
	}
	function spread(): Spread | null {
		const points = [...artPointers.values()];
		if (points.length !== 3) return null;
		const cx = points.reduce((sum, p) => sum + p.x, 0) / 3, cy = points.reduce((sum, p) => sum + p.y, 0) / 3;
		return { cx, cy, spread: points.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / 3 };
	}
	function threeFingerMove() {
		const now = spread(), gesture = threeFinger;
		if (!now || !gesture) return;
		const { start, last } = gesture;
		if (gesture.mode === 'pending') {
			const dx = now.cx - start.cx, dy = now.cy - start.cy;
			if (Math.abs(Math.log(now.spread / Math.max(1, start.spread))) > .1) gesture.mode = 'pinch';
			else if (Math.hypot(dx, dy) > 16) gesture.mode = Math.abs(dx) > Math.abs(dy) ? 'panX' : 'panY';
			else return;
		}
		const width = Math.max(1, art?.clientWidth || 1), height = Math.max(1, art?.clientHeight || 1);
		if (gesture.mode === 'pinch' && last.spread > 0) { strength = Math.max(0, Math.min(1, strength + Math.log(now.spread / last.spread) * 1.2)); showLevel(strength); }
		else if (gesture.mode === 'panX') { sharpen = Math.max(0, Math.min(1.5, sharpen + (now.cx - last.cx) / width * 1.5)); showLevel(sharpen / 1.5); }
		else if (gesture.mode === 'panY') { grain = Math.max(0, Math.min(1, grain - (now.cy - last.cy) / height * 1.5)); showLevel(grain); }
		gesture.last = now;
		schedulePaint();
	}
	function twoFingerMove() {
		const now = pair(), gesture = twoFinger;
		if (!now || !gesture) return;
		const { start, last } = gesture;
		if (gesture.mode === 'pending') {
			// Lock to the first clear intent so a pan does not also rotate or pinch.
			const dx = now.cx - start.cx, dy = now.cy - start.cy, rotation = turn(now.angle - start.angle), scale = Math.log(now.distance / Math.max(1, start.distance));
			if (Math.abs(rotation) > .17) gesture.mode = 'rotate';
			else if (Math.abs(scale) > .08) gesture.mode = 'pinch';
			else if (Math.hypot(dx, dy) > 14) gesture.mode = Math.abs(dx) > Math.abs(dy) ? 'panX' : 'panY';
			else return;
		}
		const width = Math.max(1, art?.clientWidth || 1), height = Math.max(1, art?.clientHeight || 1);
		if (gesture.mode === 'pinch' && last.distance > 0) { bandWidth = Math.max(.25, Math.min(3, bandWidth * now.distance / last.distance)); showLevel((bandWidth - .25) / 2.75); }
		else if (gesture.mode === 'panX') { contrast = limit(contrast * Math.exp((now.cx - last.cx) / width * 2)); showLevel(.5 + Math.log(contrast) / Math.log(16)); }
		else if (gesture.mode === 'panY') { gamma = limit(gamma * Math.exp((now.cy - last.cy) / height * 2)); showLevel(.5 - Math.log(gamma) / Math.log(16)); }
		else if (gesture.mode === 'rotate') {
			// A dial: every 30 degrees turns to the next expression.
			gesture.turned += turn(now.angle - last.angle);
			const steps = Math.trunc(gesture.turned / (Math.PI / 6));
			if (steps) {
				gesture.turned -= steps * Math.PI / 6;
				const count = VATHOGRAPHY_PRESETS.length;
				selectPreset(((preset + steps) % count + count) % count);
				showLevel(preset / (count - 1));
			}
		}
		gesture.last = now;
		if (gesture.mode !== 'rotate') schedulePaint();
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
			artGesture.axis ??= Math.abs(next.x - artGesture.x) > Math.abs(next.y - artGesture.y) ? 'x' : 'y';
			if (artGesture.axis === 'x') { setPosition(position + (next.x - last.x) / Math.max(1, art?.clientWidth || 1)); showLevel((position + 1) / 2); }
			else {
				// Up brings in more of the photograph's own structure.
				structure = Math.max(0, Math.min(1, structure - (next.y - last.y) / Math.max(1, art?.clientHeight || 1) * 1.5));
				showLevel(structure); schedulePaint();
			}
		} else if (artPointers.size === 2) twoFingerMove();
		else if (artPointers.size === 3) threeFingerMove();
	}
	function endTwoFinger() {
		const gesture = twoFinger;
		twoFinger = null;
		if (!gesture || gesture.mode !== 'pending' || performance.now() - gesture.time > 300 || mode !== 'done') return;
		const now = performance.now();
		if (now - lastTwoTap < 400) { lastTwoTap = 0; resetTone(); }
		else lastTwoTap = now;
	}
	function artUp(event: PointerEvent) {
		artPointers.delete(event.pointerId);
		if (threeFinger && artPointers.size < 3) threeFinger = null;
		if (twoFinger && artPointers.size < 2) endTwoFinger();
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
		artPointers.delete(event.pointerId);
		if (artPointers.size < 3) threeFinger = null;
		if (artPointers.size < 2) twoFinger = null;
		if (artGesture?.id === event.pointerId) artGesture = null;
	}
	function keys(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (menu) closeMenu(); else if (selecting) toggleSelecting(); else if (galleryOpen) closeGallery(); else void retake();
	}
	onMount(() => {
		printSession = globalThis.crypto?.randomUUID() ?? `${Date.now()}-${Math.random()}`;
		try {
			const saved = window.localStorage?.getItem('entropi-vatho');
			if (saved && /^[0-4]$/.test(saved)) preset = Number(saved);
			const savedLook = Number(window.localStorage?.getItem('entropi-look'));
			if (Number.isInteger(savedLook) && savedLook >= 0 && savedLook < LOOKS.length) look = savedLook;
		} catch {}
		lookSlider = attachEdgeQualitySlider(window, {edge: 'left', levels: LOOKS.length, initialLevel: look, onLevel: selectLook,
			onActive: active => { lookActive = active; }});
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
		void processUploads();
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
				if (mode !== 'camera' || galleryOpen) return;
				if (stream && !stream.getVideoTracks().some(track => track.readyState === 'live')) stopCamera();
				void startCamera();
			}, 300);
		};
		window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
		window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume);
		return () => {
			disposed = true; generation++; clearTimeout(resumeTimer); clearTapBatch(); recorder.abort();
			presetSlider?.dispose(); presetSlider = null;
			lookSlider?.dispose(); lookSlider = null; clearTimeout(levelTimer);
			shake?.dispose(); shake = null;
			window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume);
			window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
			window.removeEventListener('beacio:ready', restorePrinter); window.removeEventListener('beacio:extension:ready', restorePrinter);
			printerChecks.forEach(clearTimeout); printer?.removeEventListener('status', printStatus); printer?.dispose(); printer = null;
			estimator.dispose(); stopPanorama(); stopCamera(); preview?.dispose(); clearResult(); captured = null; releaseGallery();
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
	<div class="cloud art" class:hidden={mode !== 'done'} onpointerdown={artDown} onpointermove={artMove} onpointerup={artUp} onpointercancel={artCancel} oncontextmenu={event => event.preventDefault()} role="img" aria-label="Djupnelitografi. Éin finger vassrett flyttar djupneområdet. To fingrar: knip for breidda, dra vassrett for kontrast, dra loddrett for mellomtonar, vri for å skifte mellom fem uttrykk, og dobbelttrykk for å nullstille. Éin finger loddrett gir struktur frå fotoet. Tre fingrar: loddrett for korn, vassrett for skarpleik, knip for fargestyrke. Dra langs høgre kant for uttrykka og langs venstre kant for fargar. Hald inne utan å flytte fingeren for utskrift. Rist for å tømme lerretet. Dobbelttrykk for eit nytt bilete.">
		<canvas bind:this={art}></canvas>
	</div>
	<div class="quality-rail" class:active={presetActive} aria-hidden="true">
		{#each [4, 3, 2, 1, 0] as level, index}<i class:chosen={preset === level} style:top={`${index * 20 + 10}%`}></i>{/each}
	</div>
	<div class="quality-rail primitive-rail" class:active={lookActive} aria-hidden="true">
		{#each LOOKS.map((_, index) => LOOKS.length - 1 - index) as level, index}<i class:chosen={look === level} style:top={`${(index + .5) * 100 / LOOKS.length}%`} style:background={`linear-gradient(90deg, rgb(${LOOKS[level].stops[0][1]}), rgb(${LOOKS[level].stops.at(-1)?.[1]}))`}></i>{/each}
	</div>
	{#if level !== null}<div class="level" aria-hidden="true"><i style:width={`${level * 100}%`}></i></div>{/if}
	{#if mode === 'done'}
		<button class="access-control" type="button" aria-label="Ta eit nytt bilete" onclick={retake}><i class="plus" aria-hidden="true"></i></button>
		<a class="access-control download" href="/" download="entropi-djupn.png" aria-label="Last ned djupnebiletet" onclick={saveArt}><i class="download-mark" aria-hidden="true"></i></a>
	{/if}
	{#if (mode === 'camera' || mode === 'done') && !galleryOpen}
		<button class="access-control gallery-control" type="button" aria-label="Opne galleriet" onclick={openGallery}><i class="grid-mark" aria-hidden="true"></i></button>
	{/if}
	{#if galleryOpen}
		<div class="gallery" role="dialog" aria-modal="true" aria-label="Galleri">
			<button class="gallery-upload" type="button" aria-label="Last opp bilete til galleriet. Fleire bilete kan veljast samstundes." onclick={() => uploadInput?.click()}><i class="plus" aria-hidden="true"></i></button>
			<button class="gallery-select" class:active={selecting} type="button" aria-pressed={selecting} aria-label={selecting ? 'Avslutt utval' : 'Vel fleire bilete'} onclick={() => toggleSelecting()}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.6-5" /></svg>
			</button>
			<button class="gallery-close" type="button" aria-label="Lukk galleriet" onclick={closeGallery}><i class="plus close" aria-hidden="true"></i></button>
			<div class="gallery-grid">
				{#each { length: uploading }, index (index)}
					<div class="pending" aria-hidden="true"><div class="progress indeterminate"><i style:width="28%"></i></div></div>
				{/each}
				{#each galleryItems as item (item.id)}
					<button type="button" class:held={menu?.id === item.id} class:selected={selecting && selected.includes(item.id)} aria-pressed={selecting ? selected.includes(item.id) : undefined} aria-label={`Opne djupnebilete frå ${new Date(item.created).toLocaleString('nn-NO')}. Hald inne for å lagre, dele eller slette.`}
						onpointerdown={event => tileDown(event, item)} onpointermove={tileMove} onpointerup={cancelPress} onpointercancel={cancelPress}
						oncontextmenu={event => event.preventDefault()} onclick={() => tileClick(item.id)}><img src={item.url} alt="" /></button>
				{/each}
			</div>
			{#if selecting && selected.length}
				<div class="quick-menu selection-bar" role="toolbar" aria-label={`${selected.length} valde bilete`}>
					<button type="button" aria-label={`Lagre ${selected.length} bilete i bilete`} disabled={!selectionReady()} onclick={saveSelection}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
					</button>
					{#if selectionReady() && shareable(selectionFiles())}
						<button type="button" aria-label={`Del ${selected.length} bilete`} onclick={shareSelection}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M7 11H5v9h14v-9h-2" /></svg>
						</button>
					{/if}
					<button type="button" class:armed={selectionArmed} aria-label={selectionArmed ? `Stadfest sletting av ${selected.length} bilete` : `Slett ${selected.length} bilete`} onclick={deleteSelection}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" /></svg>
					</button>
				</div>
			{/if}
			{#if menu}
				<div class="menu-catcher" role="presentation" onpointerdown={closeMenu}></div>
				<div class="quick-menu" role="menu" aria-label="Handlingar for biletet" style:left={`${menu.x}px`} style:top={`${menu.y}px`}>
					<button type="button" role="menuitem" aria-label="Vel fleire bilete, med dette" onclick={() => menu && toggleSelecting(menu.id)}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.6-5" /></svg>
					</button>
					<button type="button" role="menuitem" aria-label="Lagre i bilete" disabled={!menu.file} onclick={saveMenu}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>
					</button>
					{#if menu.file && canShareFiles(menu.file)}
						<button type="button" role="menuitem" aria-label="Del biletet" onclick={shareMenu}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M7 11H5v9h14v-9h-2" /></svg>
						</button>
					{/if}
					<button type="button" role="menuitem" class:armed={menu.armed} aria-label={menu.armed ? 'Stadfest sletting' : 'Slett biletet'} onclick={deleteMenu}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" /></svg>
					</button>
				</div>
			{/if}
		</div>
	{/if}
	<input bind:this={uploadInput} type="file" accept="image/*" multiple onchange={uploadToGallery} tabindex="-1" aria-label="Bilete til galleriet" />
	<input bind:this={photoInput} type="file" accept="image/*" multiple onchange={capture} oncancel={() => void startCamera()} tabindex="-1" aria-label="Kamerabilete" />
	<input class="sr-only" type="range" min="0" max="4" step="1" value={preset} aria-label="Djupneuttrykk" aria-valuetext={VATHOGRAPHY_PRESETS[preset].label} oninput={event => selectPreset(Number(event.currentTarget.value))} />
	<input class="sr-only" type="range" min="-1" max="1" step="0.02" value={position} aria-label="Djupneområde" oninput={event => setPosition(Number(event.currentTarget.value))} />
	<input class="sr-only" type="range" min="0.25" max="4" step="0.05" value={contrast} aria-label="Kontrast" oninput={event => { contrast = Number(event.currentTarget.value); if (mode === 'done') schedulePaint(); }} />
	<input class="sr-only" type="range" min="0" max={LOOKS.length - 1} step="1" value={look} aria-label="Fargeuttrykk" aria-valuetext={LOOKS[look].label} oninput={event => selectLook(Number(event.currentTarget.value))} />
	<input class="sr-only" type="range" min="0" max="1" step="0.05" value={structure} aria-label="Struktur frå fotoet" oninput={event => { structure = Number(event.currentTarget.value); if (mode === 'done') schedulePaint(); }} />
	<input class="sr-only" type="range" min="0" max="1.5" step="0.05" value={sharpen} aria-label="Skarpleik" oninput={event => { sharpen = Number(event.currentTarget.value); if (mode === 'done') schedulePaint(); }} />
	<input class="sr-only" type="range" min="0" max="1" step="0.05" value={grain} aria-label="Korn" oninput={event => { grain = Number(event.currentTarget.value); if (mode === 'done') schedulePaint(); }} />
	<input class="sr-only" type="range" min="0" max="1" step="0.05" value={strength} aria-label="Fargestyrke" oninput={event => { strength = Number(event.currentTarget.value); if (mode === 'done') schedulePaint(); }} />
	<input class="sr-only" type="range" min="0.25" max="4" step="0.05" value={gamma} aria-label="Mellomtonar, lågare er lysare" oninput={event => { gamma = Number(event.currentTarget.value); if (mode === 'done') schedulePaint(); }} />
	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
	<span class="sr-only" role="status" aria-live="polite">{printerAnnouncement}</span>
</main>
