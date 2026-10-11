<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { MAX_UPLOAD_BYTES } from '../lib/triposplat';

	let video = $state<HTMLVideoElement | undefined>(undefined);
	let photoInput = $state<HTMLInputElement | undefined>(undefined);
	let stream: MediaStream | null = null;
	let mode = $state<'camera' | 'working' | 'done'>('camera');
	let jobId = $state('');
	let announcement = $state('');
	let activeId = '';
	let disposed = false;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;

	function stopCamera() {
		stream?.getTracks().forEach((track) => track.stop());
		stream = null;
		if (video) video.srcObject = null;
	}

	function openCapture() {
		stopCamera();
		photoInput?.click();
	}

	async function startCamera() {
		if (!video || !navigator.mediaDevices?.getUserMedia) return;
		try {
			const next = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' } },
				audio: false
			});
			if (disposed || mode !== 'camera') {
				next.getTracks().forEach((track) => track.stop());
				return;
			}
			stream = next;
			video.srcObject = next;
			await video.play().catch(() => {});
		} catch {
			announcement = 'Tap the capture button to use your camera or select a photo.';
		}
	}

	onMount(() => {
		void startCamera();
		const resume = () => {
			clearTimeout(resumeTimer);
			resumeTimer = setTimeout(() => {
				if (mode === 'camera' && !stream) void startCamera();
			}, 300);
		};
		window.addEventListener('focus', resume);
		document.addEventListener('visibilitychange', resume);
		return () => {
			disposed = true;
			activeId = '';
			clearTimeout(resumeTimer);
			window.removeEventListener('focus', resume);
			document.removeEventListener('visibilitychange', resume);
			stopCamera();
		};
	});

	async function prepareImage(file: File): Promise<File> {
		const bitmap = await createImageBitmap(file);
		try {
			const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Could not prepare this photo.');
			context.fillStyle = '#fff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			for (const quality of [0.86, 0.7, 0.5]) {
				const blob = await new Promise<Blob>((resolve, reject) => {
					canvas.toBlob(
						(result) => result ? resolve(result) : reject(new Error('Could not prepare this photo.')),
						'image/jpeg',
						quality
					);
				});
				if (blob.size <= MAX_UPLOAD_BYTES) {
					return new File([blob], 'capture.jpg', { type: 'image/jpeg' });
				}
			}
			throw new Error('This photo is too large to upload. Try another photo.');
		} finally {
			bitmap.close();
		}
	}

	async function readJson(response: Response) {
		const data = await response.json().catch(() => null);
		if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'The generation server is unavailable.');
		return data;
	}

	async function waitForJob(id: string) {
		while (activeId === id) {
			const response = await fetch(`/triposplat/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
			const data = await readJson(response);
			if (activeId !== id) return;
			if (data.status === 'completed') {
				jobId = id;
				mode = 'done';
				announcement = '3D splat ready.';
				return;
			}
			if (data.status === 'failed') {
				throw new Error(typeof data.error === 'string' ? data.error : 'Generation failed.');
			}
			announcement = 'Generating 3D splat.';
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}

	async function capture(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const selected = input.files?.[0];
		input.value = '';
		if (!selected) return;
		mode = 'working';
		announcement = 'Uploading photo.';
		stopCamera();
		try {
			const image = await prepareImage(selected);
			const form = new FormData();
			form.set('image', image, image.name);
			const response = await fetch('/triposplat/api/jobs', { method: 'POST', body: form });
			const data = await readJson(response);
			if (typeof data?.id !== 'string') throw new Error('Generation server returned an invalid job.');
			activeId = data.id;
			await waitForJob(data.id);
		} catch (error) {
			if (disposed) return;
			mode = 'camera';
			announcement = 'Capture failed.';
			window.alert(error instanceof Error ? error.message : 'Could not generate a 3D splat.');
			await tick();
			void startCamera();
		}
	}

	async function retake() {
		activeId = '';
		jobId = '';
		mode = 'camera';
		announcement = '';
		await tick();
		void startCamera();
	}
</script>

<svelte:head>
	<title>entropi · TripoSplat</title>
	<meta name="description" content="Take a photo and turn it into a 3D Gaussian splat." />
</svelte:head>

<main class="camera">
	{#if mode === 'done' && jobId}
		<iframe title="3D splat viewer" src={`/triposplat-viewer.html?job=${encodeURIComponent(jobId)}`}></iframe>
		<button class="retake" type="button" aria-label="Take another photo" onclick={retake}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M5.5 9A7 7 0 0 1 18 7l2 4M4 13l2 4a7 7 0 0 0 12.5-2" /></svg>
		</button>
		<a class="download" href={`/triposplat/api/jobs/${encodeURIComponent(jobId)}/artifact`} download={`triposplat-${jobId}.splat`} aria-label="Download 3D splat">
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v4h16v-4" /></svg>
		</a>
	{:else}
		<video bind:this={video} autoplay muted playsinline></video>
		{#if mode === 'camera'}
			<button class="capture" type="button" aria-label="Take a photo" onclick={openCapture}><span class="shutter" aria-hidden="true"></span></button>
		{:else}
			<div class="working" role="progressbar" aria-label="Generating 3D splat"><span></span></div>
		{/if}
	{/if}
	<input bind:this={photoInput} id="photo" type="file" accept="image/*" capture="environment" onchange={capture} oncancel={() => void startCamera()} />
	<span class="sr-only" role="status" aria-live="polite">{announcement}</span>
</main>

<style>
	.camera { position: fixed; inset: 0; overflow: hidden; background: #000; }
	video, iframe { display: block; width: 100%; height: 100%; border: 0; object-fit: cover; }
	.capture { position: absolute; inset: 0; display: flex; justify-content: center; align-items: end; padding-bottom: max(28px, env(safe-area-inset-bottom)); border: 0; background: transparent; cursor: pointer; }
	.shutter { width: 74px; height: 74px; border: 4px solid #fff; border-radius: 50%; box-shadow: 0 0 0 2px #0008; display: grid; place-items: center; }
	.shutter::after { content: ''; width: 54px; height: 54px; border-radius: 50%; background: #fff; }
	input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
	.working { position: absolute; inset: 0; display: grid; place-items: center; }
	.working span { width: 56px; height: 56px; border: 4px solid #fff5; border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.retake, .download { position: absolute; display: grid; place-items: center; width: 48px; height: 48px; background: #0009; border: 1px solid #fff7; border-radius: 50%; color: #fff; cursor: pointer; }
	.retake { top: max(18px, env(safe-area-inset-top)); left: 18px; }
	.download { top: max(18px, env(safe-area-inset-top)); right: 18px; }
	svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
</style>
