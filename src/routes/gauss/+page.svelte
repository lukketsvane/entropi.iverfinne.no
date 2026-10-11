<script lang="ts">
	import { onMount } from 'svelte';
	import SplatViewer from './SplatViewer.svelte';

	type Job = {
		id: string;
		status: string;
		progress?: number;
		error?: string;
		artifactUrl?: string;
	};

	let cameraInput = $state<HTMLInputElement>();
	let libraryInput = $state<HTMLInputElement>();
	let photo = $state<File | null>(null);
	let photoUrl = $state('');
	let accessKey = $state('');
	let jobId = $state('');
	let stage = $state<'capture' | 'uploading' | 'processing' | 'result'>('capture');
	let status = $state('');
	let progress = $state<number | null>(null);
	let result = $state<Blob | null>(null);
	let message = $state('');
	let viewerMessage = $state('');
	let showInstallHint = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = true;

	const imageLimit = 1_900_000;

	function stopPolling() {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function apiHeaders() {
		return { 'X-Gauss-Key': accessKey.trim() };
	}

	function clearPhoto() {
		if (photoUrl) URL.revokeObjectURL(photoUrl);
		photoUrl = '';
		photo = null;
	}

	function reset() {
		stopPolling();
		clearPhoto();
		result = null;
		jobId = '';
		status = '';
		progress = null;
		message = '';
		viewerMessage = '';
		stage = 'capture';
		localStorage.removeItem('gauss.job-id');
		if (cameraInput) cameraInput.value = '';
		if (libraryInput) libraryInput.value = '';
	}

	async function decodedImage(file: File) {
		const url = URL.createObjectURL(file);
		try {
			const image = new Image();
			image.src = url;
			await image.decode();
			return image;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	function jpeg(canvas: HTMLCanvasElement, quality: number) {
		return new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('JPEG-koding feila'))), 'image/jpeg', quality);
		});
	}

	async function preparePhoto(file: File) {
		const image = await decodedImage(file);
		const canvas = document.createElement('canvas');
		const scale = Math.min(1, 1536 / Math.max(image.naturalWidth, image.naturalHeight));
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Biletet kunne ikkje behandlast');
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		let blob = await jpeg(canvas, 0.86);
		for (let quality = 0.76; blob.size > imageLimit && quality >= 0.46; quality -= 0.1) {
			blob = await jpeg(canvas, quality);
		}
		while (blob.size > imageLimit && Math.max(canvas.width, canvas.height) > 700) {
			const smaller = document.createElement('canvas');
			smaller.width = Math.round(canvas.width * 0.82);
			smaller.height = Math.round(canvas.height * 0.82);
			const smallerContext = smaller.getContext('2d');
			if (!smallerContext) break;
			smallerContext.drawImage(canvas, 0, 0, smaller.width, smaller.height);
			canvas.width = smaller.width;
			canvas.height = smaller.height;
			context.drawImage(smaller, 0, 0);
			blob = await jpeg(canvas, 0.72);
		}
		if (blob.size > imageLimit) throw new Error('Biletet er for stort. Prøv eit anna bilete.');
		return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
	}

	async function choose(file?: File) {
		if (!file) return;
		message = '';
		try {
			const ready = await preparePhoto(file);
			clearPhoto();
			photo = ready;
			photoUrl = URL.createObjectURL(ready);
		} catch (error) {
			message = error instanceof Error && error.message.startsWith('Biletet er for stort')
				? error.message
				: 'Biletet kunne ikkje opnast på denne iPhonen. Prøv eit JPEG-bilete.';
		}
	}

	function jobState(value: string) {
		if (['completed', 'complete', 'done', 'succeeded'].includes(value)) return 'completed';
		if (['failed', 'error', 'cancelled'].includes(value)) return 'failed';
		return 'processing';
	}

	async function readResponse(response: Response) {
		if (response.status === 401 || response.status === 403) {
			throw new Error('Feil tilgangskode. Sjekk koden og prøv igjen.');
		}
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new Error(typeof body.error === 'string' ? body.error : `Tenaren svarte ${response.status}.`);
		}
		return response.json() as Promise<Job>;
	}

	async function loadResult(id: string) {
		const response = await fetch(`/api/gauss/jobs/${encodeURIComponent(id)}/artifact`, {
			headers: apiHeaders(),
			cache: 'no-store'
		});
		if (!response.ok) throw new Error('3D-fila kunne ikkje lastast ned. Prøv igjen.');
		result = await response.blob();
		viewerMessage = '';
		stage = 'result';
	}

	async function poll(id: string) {
		try {
			const response = await fetch(`/api/gauss/jobs/${encodeURIComponent(id)}`, {
				headers: apiHeaders(),
				cache: 'no-store'
			});
			const job = await readResponse(response);
			if (!active || id !== jobId) return;
			status = job.status;
			progress = typeof job.progress === 'number'
				? Math.max(0, Math.min(100, Math.round(job.progress <= 1 ? job.progress * 100 : job.progress)))
				: null;
			const state = jobState(job.status);
			if (state === 'completed') {
				stopPolling();
				await loadResult(id);
			} else if (state === 'failed') {
				stopPolling();
				message = job.error || '3D-behandlinga feila. Prøv med eit anna bilete.';
				stage = 'capture';
			} else {
				stage = 'processing';
				timer = setTimeout(() => poll(id), 2500);
			}
		} catch (error) {
			if (!active || id !== jobId) return;
			message = error instanceof Error ? error.message : 'Fekk ikkje kontakt med tenaren.';
			stage = 'capture';
		}
	}

	async function create() {
		if (!photo || !accessKey.trim()) {
			message = photo ? 'Skriv inn tilgangskoden for å halde fram.' : 'Ta eller vel eit bilete først.';
			return;
		}
		message = '';
		localStorage.setItem('gauss.access-key', accessKey.trim());
		stage = 'uploading';
		try {
			const body = new FormData();
			body.append('image', photo, 'photo.jpg');
			const response = await fetch('/api/gauss/jobs', { method: 'POST', headers: apiHeaders(), body });
			const job = await readResponse(response);
			if (!job.id) throw new Error('Tenaren gav ingen jobb-ID.');
			jobId = job.id;
			localStorage.setItem('gauss.job-id', job.id);
			stage = 'processing';
			await poll(job.id);
		} catch (error) {
			message = error instanceof Error ? error.message : 'Opplastinga feila. Prøv igjen.';
			stage = 'capture';
		}
	}

	async function download() {
		if (!result) return;
		const url = URL.createObjectURL(result);
		const link = document.createElement('a');
		link.href = url;
		link.download = `formnerd-${jobId || 'gauss'}.splat`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}

	function retry() {
		if (!accessKey.trim()) {
			message = 'Skriv inn tilgangskoden for å halde fram.';
			return;
		}
		localStorage.setItem('gauss.access-key', accessKey.trim());
		message = '';
		stage = 'processing';
		poll(jobId);
	}

	onMount(() => {
		const htmlTouchAction = document.documentElement.style.touchAction;
		const bodyTouchAction = document.body.style.touchAction;
		document.documentElement.style.touchAction = 'auto';
		document.body.style.touchAction = 'auto';
		showInstallHint = /iPhone|iPad|iPod/.test(navigator.userAgent) &&
			!window.matchMedia('(display-mode: standalone)').matches &&
			!('standalone' in navigator && navigator.standalone);
		const fragment = new URLSearchParams(location.hash.slice(1));
		const sharedKey = fragment.get('key');
		if (sharedKey) {
			accessKey = sharedKey;
			localStorage.setItem('gauss.access-key', sharedKey);
			history.replaceState(history.state, '', location.pathname + location.search);
		} else {
			accessKey = localStorage.getItem('gauss.access-key') || '';
		}
		const lastJob = localStorage.getItem('gauss.job-id');
		if (lastJob && accessKey) {
			jobId = lastJob;
			stage = 'processing';
			poll(lastJob);
		}
		return () => {
			active = false;
			stopPolling();
			clearPhoto();
			document.documentElement.style.touchAction = htmlTouchAction;
			document.body.style.touchAction = bodyTouchAction;
		};
	});
</script>

<svelte:head>
	<title>Gauss — FormNerd</title>
	<meta name="description" content="Ta eit bilete. FormNerd lagar ein 3D Gaussian av det." />
	<meta name="theme-color" content="#11100e" />
	<meta name="apple-mobile-web-app-title" content="Gauss" />
	<link rel="manifest" href="/gauss.webmanifest" />
	<link rel="icon" type="image/png" sizes="512x512" href="/gauss-icon.png" />
	<link rel="apple-touch-icon" href="/gauss-icon.png" />
</svelte:head>

<div class="app">
	<div class="grain"></div>
	<header class="topbar">
		<div class="brand"><span class="mark">F<span class="mark-second">N</span></span><span class="brand-name">FORMNERD <b>/</b> GAUSS</span></div>
		<span class="top-index">01—03</span>
	</header>

	<main>
		<div class="eyebrow"><span class="live-dot"></span> GENERATIV 3D</div>
		<h1>{stage === 'result' ? 'Eit nytt perspektiv.' : 'Frå eit bilete til rom.'}</h1>
		<p class="intro">{stage === 'result' ? 'Dra for å sjå modellen frå alle sider.' : 'Ta eit bilete med iPhone. Datamaskina di byggjer ein 3D Gaussian.'}</p>

		<section class:loaded={!!photoUrl || stage === 'result'} class="frame" aria-label="Bilete og 3D-visning">
			<div class="frame-corner tl"></div><div class="frame-corner tr"></div><div class="frame-corner bl"></div><div class="frame-corner br"></div>
			{#if stage === 'result' && result}
				<SplatViewer data={result} onerror={(text) => (viewerMessage = text)} />
				<div class="frame-label"><span>3D GAUSSIAN</span><span>DRAG / ROTER</span></div>
			{:else if photoUrl}
				<img class="preview" src={photoUrl} alt="Valt bilete" />
				{#if stage === 'processing' || stage === 'uploading'}
					<div class="processing-overlay"><div class="orb"><i></i><i></i><i></i></div><span>{stage === 'uploading' ? 'LASTAR OPP' : 'BYGGJER 3D'}</span></div>
				{:else}
					<div class="frame-label"><span>KJELDEBILETE</span><span>{(photo?.size || 0) / 1024 > 999 ? `${((photo?.size || 0) / 1048576).toFixed(1)} MB` : `${Math.round((photo?.size || 0) / 1024)} KB`}</span></div>
				{/if}
			{:else}
				<div class="empty-art"><div class="halo halo-a"></div><div class="halo halo-b"></div><div class="halo halo-c"></div><div class="core"></div></div>
				{#if stage === 'processing'}<div class="processing-overlay"><div class="orb"><i></i><i></i><i></i></div><span>BYGGJER 3D</span></div>{/if}
				<div class="frame-label"><span>{stage === 'processing' ? 'BEHANDLAR' : 'KLAR FOR OPPTAK'}</span><span>FOTO → 3D</span></div>
			{/if}
		</section>

		{#if stage === 'processing' || stage === 'uploading'}
			<div class="status-row"><span class="pulse"></span><span>{stage === 'uploading' ? 'Sender biletet' : status === 'queued' ? 'Ventar på datamaskina' : 'Datamaskina lagar modellen'}</span><strong>{progress === null ? '…' : `${progress}%`}</strong></div>
			<div class="progress-track"><span style={`width: ${progress ?? 8}%`}></span></div>
			<p class="secondary-note">Dette kan ta nokre minutt. Du kan opne appen igjen seinare.</p>
		{:else if stage === 'result'}
			{#if viewerMessage}<p class="alert" role="alert">{viewerMessage}</p>{/if}
			<div class="actions"><button class="primary" onclick={download}><span>Last ned 3D-fila</span><span class="arrow">↗</span></button><button class="secondary" onclick={reset}>Nytt bilete</button></div>
		{:else}
			<input bind:this={cameraInput} class="hidden-input" type="file" accept="image/*" capture="environment" onchange={(event) => choose(event.currentTarget.files?.[0])} />
			<input bind:this={libraryInput} class="hidden-input" type="file" accept="image/*" onchange={(event) => choose(event.currentTarget.files?.[0])} />
			<div class="actions">
				{#if photo}
					<button class="primary" onclick={create}><span>Lag 3D-modell</span><span class="arrow">↗</span></button>
					<button class="secondary" onclick={() => cameraInput?.click()}>Ta om</button>
				{:else if jobId}
					<button class="primary" onclick={retry}><span>Prøv 3D-jobben igjen</span><span class="arrow">↗</span></button>
					<button class="secondary" onclick={reset}>Nytt bilete</button>
				{:else}
					<button class="primary" onclick={() => cameraInput?.click()}><span>Ta bilete</span><span class="camera-glyph"><i></i></span></button>
					<button class="secondary" onclick={() => libraryInput?.click()}>Vel frå bilete</button>
				{/if}
			</div>
			{#if photo || jobId}
				<label class="key-label" for="gauss-key">TILGANGSKODE</label>
				<input id="gauss-key" class="key-input" type="password" bind:value={accessKey} autocomplete="off" placeholder="Skriv inn koden" />
			{/if}
			{#if showInstallHint && !photo && !jobId}<p class="install-tip">På iPhone: trykk Del ↗ og «Legg til på Hjem-skjerm».</p>{/if}
			{#if message}<p class="alert" role="alert">{message}</p>{/if}
		{/if}
	</main>

	<footer><span>FORMNERD STUDIO</span><span>01 / 03</span><span>© 2026</span></footer>
</div>

<style>
	:global(html), :global(body) { background: #11100e; }
	.app { position: fixed; inset: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; background: radial-gradient(ellipse 80% 48% at 51% 43%, #27221b 0, #171512 50%, #11100e 100%); color: #f3efe7; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
	.grain { position: fixed; inset: 0; pointer-events: none; opacity: .2; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.22'/%3E%3C/svg%3E"); }
	.topbar { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center; height: 76px; padding: max(14px, env(safe-area-inset-top)) 25px 0; border-bottom: 1px solid #ffffff12; }
	.brand { display: flex; align-items: center; gap: 12px; }
	.mark { display: flex; align-items: center; justify-content: center; width: 37px; height: 37px; border: 1px solid #d8b07a; border-radius: 50%; color: #e1c297; font-size: 12px; font-weight: 700; letter-spacing: -.2em; padding-right: .16em; }
	.mark-second { transform: translateY(3px); }
	.brand-name, .top-index, .eyebrow, .frame-label, .key-label, footer, .processing-overlay > span { font-family: 'Michroma', ui-monospace, monospace; font-size: 8px; letter-spacing: .16em; }
	.brand-name { color: #d8d1c4; white-space: nowrap; }
	.brand-name b { color: #9e7953; font-weight: 400; margin: 0 3px; }
	.top-index { color: #8f887e; }
	main { position: relative; z-index: 1; max-width: 540px; margin: 0 auto; padding: 30px 25px 46px; }
	.eyebrow { display: flex; align-items: center; gap: 9px; color: #caaa82; }
	.live-dot, .pulse { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #d9ad70; box-shadow: 0 0 13px #dfad68; }
	h1 { margin: 20px 0 8px; max-width: 370px; font-weight: 500; letter-spacing: -.055em; line-height: 1.08; font-size: clamp(34px, 9vw, 48px); }
	.intro { margin: 0 0 26px; max-width: 320px; color: #a9a29a; font-size: 13px; line-height: 1.5; }
	.frame { position: relative; width: 100%; aspect-ratio: .89; max-height: min(48dvh, 510px); background: radial-gradient(circle at 50% 52%, #2e261e, #171513 64%, #12110f); border: 1px solid #98806555; overflow: hidden; box-shadow: inset 0 0 0 8px #ffffff04, 0 22px 50px #0006; }
	.frame:before { content: ''; position: absolute; z-index: 1; inset: 9px; border: 1px solid #ffffff17; pointer-events: none; }
	.frame-corner { position: absolute; z-index: 5; width: 18px; height: 18px; border-color: #d9b98a; border-style: solid; pointer-events: none; }
	.tl { left: 8px; top: 8px; border-width: 1px 0 0 1px; } .tr { right: 8px; top: 8px; border-width: 1px 1px 0 0; } .bl { left: 8px; bottom: 8px; border-width: 0 0 1px 1px; } .br { right: 8px; bottom: 8px; border-width: 0 1px 1px 0; }
	.preview { width: 100%; height: 100%; display: block; object-fit: cover; }
	.frame-label { position: absolute; z-index: 5; left: 24px; right: 24px; bottom: 23px; display: flex; justify-content: space-between; color: #d6cbbd; text-shadow: 0 1px 7px #000; }
	.empty-art { position: absolute; inset: 0; display: grid; place-items: center; perspective: 500px; }
	.halo { position: absolute; width: 51%; aspect-ratio: 1; border: 1px solid #ba8d5b66; border-radius: 50%; box-shadow: 0 0 30px #d1964422, inset 0 0 30px #d1964414; transform: rotateX(62deg) rotateZ(18deg); }
	.halo-b { transform: rotateX(63deg) rotateY(62deg) rotateZ(-17deg); width: 58%; }
	.halo-c { transform: rotateX(45deg) rotateY(-38deg) rotateZ(22deg); width: 46%; }
	.core { width: 12px; height: 12px; border-radius: 50%; background: #efca9c; box-shadow: 0 0 18px 8px #e7b67a66, 0 0 80px 35px #c88e3c27; }
	.processing-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 26px; align-items: center; justify-content: center; background: #15110ecb; color: #f0d7b5; }
	.orb { position: relative; width: 95px; height: 95px; animation: spin 4s linear infinite; }
	.orb i { position: absolute; inset: 7px; border-radius: 50%; border: 1px solid #d6a66e; transform: rotateX(65deg) rotateY(20deg); box-shadow: 0 0 12px #c99559aa; }
	.orb i:nth-child(2) { transform: rotateX(61deg) rotateY(80deg); }
	.orb i:nth-child(3) { transform: rotateX(65deg) rotateY(-42deg); }
	@keyframes spin { to { transform: rotate(360deg); } }
	.status-row { display: flex; align-items: center; gap: 9px; margin: 21px 0 11px; color: #d5c7b4; font-size: 12px; }
	.status-row strong { margin-left: auto; font-weight: 500; color: #e9c391; }
	.pulse { animation: blink 1.6s ease infinite; }
	@keyframes blink { 50% { opacity: .3; } }
	.progress-track { height: 2px; background: #ffffff23; }
	.progress-track span { display: block; height: 100%; background: #d9ac74; transition: width .5s ease; }
	.secondary-note { margin: 14px 0; color: #888078; font-size: 11px; line-height: 1.5; }
	.actions { display: flex; flex-direction: column; gap: 9px; margin-top: 17px; }
	button { font: inherit; cursor: pointer; }
	.primary, .secondary { min-height: 57px; display: flex; justify-content: space-between; align-items: center; padding: 0 19px; border: 1px solid transparent; border-radius: 3px; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
	.primary { background: #d9b388; color: #211913; box-shadow: 0 8px 25px #0005; }
	.primary:active { background: #e8c8a3; transform: scale(.994); }
	.secondary { min-height: 48px; justify-content: center; background: #ffffff09; color: #bdb4a8; border-color: #ffffff20; font-size: 12px; font-weight: 500; }
	.secondary:active { background: #ffffff1b; }
	.arrow { font-size: 22px; font-weight: 300; }
	.camera-glyph { position: relative; width: 25px; height: 19px; border: 1.5px solid #241c16; border-radius: 3px; }
	.camera-glyph:before { content: ''; position: absolute; left: 4px; top: -5px; width: 11px; height: 4px; background: #241c16; border-radius: 2px 2px 0 0; }
	.camera-glyph i { position: absolute; width: 9px; height: 9px; left: 7px; top: 4px; border: 1.5px solid #241c16; border-radius: 50%; }
	.hidden-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
	.key-label { display: block; margin-top: 21px; color: #a99783; }
	.key-input { display: block; width: 100%; margin-top: 7px; min-height: 44px; padding: 0 14px; border: 1px solid #ffffff2e; border-radius: 3px; outline: 0; background: #ffffff09; color: #f5efe5; font: inherit; font-size: 14px; -webkit-user-select: text; user-select: text; }
	.key-input:focus { border-color: #d9b388; }
	.alert { color: #e8a991; font-size: 12px; line-height: 1.45; }
	.install-tip { margin: 15px 0 0; color: #8e857b; font-size: 11px; line-height: 1.5; text-align: center; }
	footer { position: relative; z-index: 1; display: flex; justify-content: space-between; padding: 0 25px max(25px, env(safe-area-inset-bottom)); color: #6e675f; }
	@media (max-height: 750px) { main { padding-top: 22px; } h1 { margin-top: 12px; font-size: 34px; } .intro { margin-bottom: 18px; } .frame { max-height: 40dvh; } }
	@media (prefers-reduced-motion: reduce) { .orb, .pulse { animation: none; } }
</style>
