<script lang="ts">
	import { onMount } from 'svelte';
	import { IMAGE_TYPES, MAX_UPLOAD_BYTES } from '../../lib/triposplat';

	type Job = {
		id: string;
		status: string;
		stage?: string | null;
		progress?: number | null;
		sizeBytes?: number | null;
		error?: string | null;
	};

	let image = $state<File | null>(null);
	let preview = $state<string | null>(null);
	let job = $state<Job | null>(null);
	let busy = $state(false);
	let message = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let activeId = '';

	const percent = $derived(Math.round(Math.max(0, Math.min(1, job?.progress ?? 0)) * 100));

	onMount(() => () => {
		clearTimeout(timer);
		if (preview) URL.revokeObjectURL(preview);
	});

	function selectImage(next: File | null) {
		if (!next) return;
		if (preview) URL.revokeObjectURL(preview);
		clearTimeout(timer);
		activeId = '';
		image = null;
		preview = null;
		job = null;
		busy = false;
		if (!IMAGE_TYPES.includes(next.type)) {
			message = 'Choose a JPEG, PNG, or WebP image.';
			return;
		}
		if (next.size > MAX_UPLOAD_BYTES) {
			message = 'The image must be 4 MB or smaller.';
			return;
		}
		image = next;
		preview = URL.createObjectURL(next);
		message = '';
	}

	async function readJson(response: Response) {
		const data = await response.json().catch(() => null);
		if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Request failed.');
		return data;
	}

	async function refreshJob(id: string) {
		try {
			const response = await fetch(`/triposplat/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
			const data = await readJson(response) as Job;
			if (activeId !== id) return;
			job = data;
			if (data.status === 'completed') {
				busy = false;
			} else if (data.status === 'failed') {
				busy = false;
				message = data.error || 'Generation failed. Try another image.';
			} else {
				timer = setTimeout(() => refreshJob(id), 2000);
			}
		} catch (error) {
			if (activeId !== id) return;
			busy = false;
			message = error instanceof Error ? error.message : 'Could not check generation status.';
		}
	}

	async function generate(event: SubmitEvent) {
		event.preventDefault();
		if (!image || busy) return;
		clearTimeout(timer);
		activeId = '';
		job = null;
		busy = true;
		message = '';
		const form = new FormData();
		form.set('image', image, image.name);
		try {
			const response = await fetch('/triposplat/api/jobs', { method: 'POST', body: form });
			const data = await readJson(response) as Job;
			if (typeof data.id !== 'string') throw new Error('Generation server returned an invalid job.');
			activeId = data.id;
			job = data;
			timer = setTimeout(() => refreshJob(data.id), 1000);
		} catch (error) {
			busy = false;
			message = error instanceof Error ? error.message : 'Could not start generation.';
		}
	}

	function retryStatus() {
		if (!job) return;
		message = '';
		busy = true;
		refreshJob(job.id);
	}
</script>

<svelte:head>
	<title>TripoSplat · entropi</title>
	<meta name="description" content="Turn one image into a downloadable 3D Gaussian splat with TripoSplat." />
</svelte:head>

<div class="triposplat-page">
	<div class="frame">
		<header>
			<a class="brand" href="/" aria-label="Back to entropi camera">ENTROPI<span class="brand-mark">✳</span></a>
			<span class="header-rule"></span>
			<span class="section-name">TRIPOSPLAT / 01</span>
			<a class="camera-link" href="/">BACK TO CAMERA <span aria-hidden="true">↗</span></a>
		</header>

		<main>
			<section class="intro" aria-labelledby="page-title">
				<div class="eyebrow"><span class="signal"></span> SINGLE IMAGE → 3D</div>
				<h1 id="page-title">Turn a picture<br />into <em>space.</em></h1>
				<p class="lead">Upload one photo. TripoSplat reconstructs a 3D Gaussian splat that you can preview here and download.</p>
				<div class="specs">
					<div><span class="spec-number">01</span><span>INPUT<br /><strong>JPEG / PNG / WEBP</strong></span></div>
					<div><span class="spec-number">02</span><span>PROCESS<br /><strong>TRIPOSPLAT</strong></span></div>
					<div><span class="spec-number">03</span><span>OUTPUT<br /><strong>.SPLAT FILE</strong></span></div>
				</div>
			</section>

			<section class="workspace" aria-label="Create a 3D splat">
				<div class="workspace-top"><span>CREATE / NEW GENERATION</span><span class="workspace-index">001</span></div>
				<form onsubmit={generate}>
					<div class="image-panel">
						{#if preview}
							<img src={preview} alt="Selected upload" />
						{:else}
							<div class="placeholder" aria-hidden="true"><span class="placeholder-icon">＋</span><span>YOUR IMAGE GOES HERE</span></div>
						{/if}
						<label class="choose" class:disabled={busy} for="triposplat-image">{preview ? 'CHANGE IMAGE' : 'SELECT IMAGE'} <span aria-hidden="true">↗</span></label>
					</div>
					<input
						id="triposplat-image"
						class="file-input"
						type="file"
						accept={IMAGE_TYPES.join(',')}
						disabled={busy}
						onchange={(event) => { selectImage(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ''; }}
					/>
					<div class="file-details"><span>{image?.name ?? 'NO IMAGE SELECTED'}</span><span>MAX 4 MB</span></div>
					<button class="generate" type="submit" disabled={!image || busy}>
						<span>{busy ? 'GENERATING…' : 'GENERATE 3D SPLAT'}</span><span aria-hidden="true">↗</span>
					</button>
				</form>
				{#if job || message}
					<div class="status" aria-live="polite">
						{#if job}
							<div class="status-line"><span>JOB {job.id.slice(0, 8).toUpperCase()}</span><strong>{job.status.toUpperCase()}</strong></div>
							{#if job.status === 'running' || job.status === 'queued'}
								<div class="progress"><div style:width={`${percent}%`}></div></div>
								<div class="status-sub"><span>{job.stage?.replaceAll('_', ' ') ?? 'Waiting for server'}</span><span>{percent}%</span></div>
							{:else if job.status === 'completed'}
								<p class="success">Your splat is ready{job.sizeBytes ? ` · ${(job.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ''}.</p>
								<a class="download" href={`/triposplat/api/jobs/${encodeURIComponent(job.id)}/artifact`} download={`triposplat-${job.id}.splat`}>DOWNLOAD .SPLAT <span aria-hidden="true">↓</span></a>
								<iframe class="viewer" title="Interactive 3D splat preview" src={`/triposplat-viewer.html?job=${encodeURIComponent(job.id)}`} loading="lazy"></iframe>
							{/if}
						{/if}
						{#if message}<p class="error" role="alert">{message}</p>{/if}
						{#if job && !busy && job.status !== 'completed' && job.status !== 'failed' && message}
							<button class="retry" type="button" onclick={retryStatus}>CHECK STATUS AGAIN ↗</button>
						{/if}
					</div>
				{/if}
			</section>
		</main>

		<footer>
			<div><strong>ABOUT THE OUTPUT</strong><p>A Gaussian splat is a 3D scene representation. The .splat download is for splat viewers; it is not a printable mesh.</p></div>
			<div class="footer-links"><a href="https://www.tripo3d.ai/research/triposplat" target="_blank" rel="noopener noreferrer">RESEARCH ↗</a><a href="https://github.com/VAST-AI-Research/TripoSplat" target="_blank" rel="noopener noreferrer">SOURCE CODE ↗</a></div>
		</footer>
	</div>
</div>

<style>
	:global(html:has(.triposplat-page)), :global(body:has(.triposplat-page)) { touch-action: pan-y; }
	.triposplat-page, .triposplat-page * { user-select: text; -webkit-user-select: text; }
	.triposplat-page { position: fixed; inset: 0; overflow-y: auto; overscroll-behavior-y: contain; touch-action: pan-y; background: #0a0c0c; color: #ecf0ec; }
	.frame { width: min(1440px, 100%); min-height: 100%; margin: 0 auto; padding: 0 clamp(22px, 5vw, 82px); display: flex; flex-direction: column; }
	header { height: 84px; display: flex; align-items: center; border-bottom: 1px solid #38413e; gap: 28px; font: 11px var(--hud-font); letter-spacing: .08em; }
	header a { color: inherit; text-decoration: none; }
	.brand { font-size: 15px; letter-spacing: -.07em; white-space: nowrap; }
	.brand-mark { color: #c4f071; margin-left: 5px; font-size: 17px; }
	.header-rule { width: 1px; height: 24px; background: #48514b; }
	.section-name { color: #b2bdb5; white-space: nowrap; }
	.camera-link { margin-left: auto; white-space: nowrap; color: #b2bdb5; }
	.camera-link span { color: #c4f071; margin-left: 10px; }
	main { flex: 1; display: grid; grid-template-columns: minmax(0, 1.07fr) minmax(340px, .93fr); align-items: center; gap: clamp(45px, 8vw, 120px); padding: 72px 0 80px; }
	.eyebrow { display: flex; align-items: center; gap: 12px; color: #c4f071; font: 10px var(--hud-font); letter-spacing: .12em; }
	.signal { width: 7px; height: 7px; border-radius: 50%; background: #c4f071; box-shadow: 0 0 12px #c4f07199; }
	h1 { font: 400 clamp(50px, 6.4vw, 98px)/1.08 var(--hud-font); letter-spacing: -.09em; margin: 30px 0 26px; }
	h1 em { color: #c4f071; font-style: normal; }
	.lead { max-width: 510px; color: #aab6ad; font-size: clamp(16px, 1.4vw, 19px); line-height: 1.6; margin: 0; }
	.specs { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 74px; border-top: 1px solid #38413e; border-bottom: 1px solid #38413e; }
	.specs > div { display: flex; gap: 13px; padding: 19px 12px 19px 0; font: 9px/1.8 var(--hud-font); color: #849189; }
	.specs > div + div { border-left: 1px solid #38413e; padding-left: 17px; }
	.spec-number { color: #c4f071; }
	.specs strong { color: #e2e8e1; font-weight: 400; white-space: nowrap; }
	.workspace { border: 1px solid #627266; background: #101411; padding: clamp(20px, 2.5vw, 32px); box-shadow: 0 20px 80px #0009; }
	.workspace-top { display: flex; justify-content: space-between; color: #c4f071; font: 10px var(--hud-font); letter-spacing: .08em; padding-bottom: 22px; }
	.workspace-index { color: #78847b; }
	.image-panel { height: clamp(270px, 26vw, 385px); position: relative; border: 1px dashed #59675c; background: radial-gradient(circle at center, #19211a, #0b100d 70%); overflow: hidden; }
	.image-panel img { width: 100%; height: 100%; object-fit: contain; display: block; }
	.placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: #748478; font: 10px var(--hud-font); letter-spacing: .08em; }
	.placeholder-icon { display: grid; place-items: center; width: 62px; height: 62px; border: 1px solid #506050; border-radius: 50%; font: 40px var(--ui-font); font-weight: 200; color: #c4f071; }
	.choose { position: absolute; bottom: 16px; left: 16px; right: 16px; display: flex; justify-content: space-between; padding: 16px 18px; background: #e4ebe1; color: #142015; cursor: pointer; font: 10px var(--hud-font); letter-spacing: .05em; }
	.choose:hover { background: #c4f071; }
	.choose.disabled { cursor: not-allowed; opacity: .6; }
	.file-input { position: absolute; width: 1px; height: 1px; opacity: 0; }
	.file-input:focus-visible + .file-details { outline: 2px solid #c4f071; }
	.file-details { display: flex; justify-content: space-between; gap: 15px; padding: 15px 0 21px; color: #93a095; font: 9px var(--hud-font); white-space: nowrap; }
	.file-details span:first-child { overflow: hidden; text-overflow: ellipsis; }
	.generate, .download { width: 100%; min-height: 54px; display: flex; align-items: center; justify-content: space-between; border: 0; padding: 0 19px; background: #c4f071; color: #101910; cursor: pointer; text-decoration: none; font: 10px var(--hud-font); letter-spacing: .06em; }
	.generate:hover:not(:disabled), .download:hover { background: #d8ff94; }
	.generate:disabled { background: #424d40; color: #869184; cursor: not-allowed; }
	.viewer { display: block; width: 100%; height: 350px; margin-top: 15px; border: 1px solid #506050; background: #0a0c0c; }
	.status { margin-top: 23px; border-top: 1px solid #38413e; padding-top: 20px; }
	.status-line, .status-sub { display: flex; justify-content: space-between; gap: 12px; font: 10px var(--hud-font); color: #9daa9d; }
	.status-line strong { color: #c4f071; font-weight: 400; }
	.progress { height: 5px; background: #354137; margin: 19px 0 12px; }
	.progress > div { height: 100%; background: #c4f071; transition: width .4s ease; }
	.status-sub { font: 12px var(--ui-font); text-transform: capitalize; }
	.success, .error { font: 14px/1.5 var(--ui-font); margin: 14px 0; }
	.success { color: #c4f071; }
	.error { color: #ffaaa5; }
	.retry { border: 1px solid #839080; padding: 10px; background: transparent; color: #e1e8df; cursor: pointer; font: 9px var(--hud-font); }
	footer { display: flex; justify-content: space-between; gap: 30px; border-top: 1px solid #38413e; padding: 22px 0 27px; font: 9px var(--hud-font); color: #879588; }
	footer strong { font-weight: 400; color: #c4f071; }
	footer p { max-width: 550px; font: 12px/1.6 var(--ui-font); margin: 9px 0 0; }
	.footer-links { display: flex; gap: 24px; align-items: start; white-space: nowrap; }
	.footer-links a { color: #cad7c9; text-decoration: none; }
	a:focus-visible, button:focus-visible, label:focus-visible { outline: 2px solid #c4f071; outline-offset: 3px; }
	@media (max-width: 900px) { main { grid-template-columns: 1fr; gap: 52px; padding: 65px 0; } .intro { max-width: 620px; } .specs { margin-top: 48px; } .workspace { max-width: 650px; width: 100%; } }
	@media (max-width: 560px) { .frame { padding: 0 20px; } header { height: 70px; gap: 17px; } .brand { font-size: 12px; } .section-name { font-size: 8px; } .camera-link { font-size: 0; } .camera-link span { font-size: 18px; margin: 0; } main { padding: 55px 0 65px; gap: 43px; } h1 { font-size: clamp(44px, 11vw, 66px); margin: 26px 0 20px; } .lead { font-size: 15px; } .specs > div { gap: 7px; font-size: 7px; } .specs > div + div { padding-left: 8px; } .specs strong { white-space: normal; } .workspace { padding: 18px; } .image-panel { height: 295px; } footer { flex-direction: column; } }
</style>
