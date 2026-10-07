<script lang="ts">
	import { onMount } from 'svelte';
	import { updated } from '$app/state';
	import { version } from '$app/env';
	import Hud from '../lib/hud/Hud.svelte';
	import { Engine } from '../lib/engine/engine';
	import { CamError, cameraAlive, startCamera } from '../lib/engine/camera';
	import type { Meters, SetupInfo } from '../lib/engine/types';
	import { attachGestures } from '../lib/gesture';
	import { haptic } from '../lib/haptics';
	import { SETUPS } from '../lib/setups';

	let stage: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let video: HTMLVideoElement;

	type Status = 'boot' | 'needtap' | 'ready' | 'denied' | 'none' | 'insecure' | 'error';
	let status = $state<Status>('boot');
	let errText = $state('');

	let info = $state<SetupInfo | null>(null);
	let index = $state(0);
	let count = $state(SETUPS.length);
	let m = $state<Meters>({
		gauge: 0,
		ruler: 0.5,
		value: '.',
		chip: 'BIT',
		params: '',
		rulerEnds: ['−', '+']
	});
	let probe = $state({ x: 0.5, y: 0.5 });
	let hold = $state(0);
	let toast = $state('');
	let idle = $state(false);
	let flash = $state(false);

	let engine: Engine | null = null;
	let hinted = false;
	let hintT = 0;
	let toastT = 0;
	let idleT = 0;
	let lock: { release(): Promise<void> } | null = null;

	const store = {
		get(k: string) {
			try {
				return localStorage.getItem(k);
			} catch {
				return null;
			}
		},
		set(k: string, v: string) {
			try {
				localStorage.setItem(k, v);
			} catch {
				/* ignorer */
			}
		}
	};

	function say(text: string, ms = 3300) {
		toast = text;
		clearTimeout(toastT);
		toastT = window.setTimeout(() => (toast = ''), ms);
	}

	function touched() {
		idle = false;
		clearTimeout(idleT);
		idleT = window.setTimeout(() => (idle = true), 4500);
	}

	async function wake() {
		try {
			const nav = navigator as Navigator & {
				wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> };
			};
			lock = (await nav.wakeLock?.request('screen')) ?? null;
		} catch {
			/* ignorer */
		}
	}

	async function openCam() {
		status = 'boot';
		try {
			await startCamera(video);
			status = 'ready';
			engine?.start();
			wake();
		} catch (e) {
			if (e instanceof CamError) {
				if (e.kind === 'denied') status = 'needtap';
				else if (e.kind === 'none') status = 'none';
				else if (e.kind === 'insecure') status = 'insecure';
				else {
					status = 'error';
					errText = e.message;
				}
				if (e.kind === 'denied') errText = 'denied';
			} else {
				status = 'error';
				errText = String(e);
			}
		}
	}

	const message = $derived.by(() => {
		switch (status) {
			case 'boot':
				return { title: 'STARTAR KAMERA', body: 'Tillat kamera om iOS spør.' };
			case 'needtap':
				return { title: 'TRYKK FOR Å STARTE', body: 'Appen treng kameraet. Nektar du, slå det på i Innstillingar.' };
			case 'denied':
				return { title: 'KAMERA NEKTA', body: 'Slå på kamera for appen i Innstillingar og opne på nytt.' };
			case 'none':
				return { title: 'FANN INGEN KAMERA', body: 'Opne sida på ein iPhone. Til testing: legg til ?src=video.webm.' };
			case 'insecure':
				return { title: 'KREV HTTPS', body: 'Nettlesaren gir berre kamera på sikre sider.' };
			case 'error':
				return { title: 'FEIL', body: errText };
			default:
				return null;
		}
	});

	onMount(() => {
		let off: (() => void) | null = null;
		let ro: ResizeObserver | null = null;

		try {
			engine = new Engine(canvas, video, SETUPS, {
				onMeters: (v) => (m = v),
				onSetup: (i, idx, n) => {
					info = i;
					index = idx;
					count = n;
					store.set('entropi.setup', String(idx));
					say(i.blurb);
					// ein einaste hint om at parametrane kan trykkast på
					clearTimeout(hintT);
					if (!hinted && !store.get('entropi.cyc') && engine?.canCycle) {
						hintT = window.setTimeout(() => {
							if (hinted) return;
							hinted = true;
							store.set('entropi.cyc', '1');
							say('Trykk på talet nede til høgre: anna grovkorning.', 4200);
						}, 6500);
					}
				},
				onStall: () => {
					if (!cameraAlive(video)) openCam();
				},
				onFatal: (e) => {
					status = 'error';
					errText = e.message;
				}
			});
		} catch (e) {
			status = 'error';
			errText = String((e as Error).message ?? e);
			return;
		}

		const saved = parseInt(store.get('entropi.setup') ?? '0', 10);
		if (Number.isFinite(saved)) engine.go(saved);

		ro = new ResizeObserver(() => {
			const r = stage.getBoundingClientRect();
			engine?.resize(r.width, r.height, window.devicePixelRatio || 1);
		});
		ro.observe(stage);
		const r0 = stage.getBoundingClientRect();
		engine.resize(r0.width, r0.height, window.devicePixelRatio || 1);

		off = attachGestures(stage, {
			holdMs: 1200,
			onTouch: touched,
			onProgress: (p) => (hold = p),
			onHold: () => {
				engine?.next();
				flash = true;
				haptic([14, 40, 14]);
				setTimeout(() => (flash = false), 110);
			},
			onTap: (x, y) => {
				if (status !== 'ready') {
					openCam();
					return;
				}
				// trykk på parametrane nede til høgre: neste grovkorning
				const r = stage.getBoundingClientRect();
				const onParams = x * r.width > r.width - 190 && y * r.height > r.height - 124;
				if (onParams && engine?.canCycle) {
					const label = engine.cycle();
					if (label) {
						say(label, 2600);
						haptic(8);
						hinted = true;
						store.set('entropi.cyc', '1');
						return;
					}
				}
				const used = engine?.tap(x, y);
				if (!used) probe = { x, y };
				haptic(8);
			}
		});

		const vis = () => {
			if (document.visibilityState !== 'visible') return;
			if (updated.current) {
				location.reload();
				return;
			}
			if (status === 'ready' && !cameraAlive(video)) openCam();
			wake();
		};
		document.addEventListener('visibilitychange', vis);

		(window as unknown as Record<string, unknown>).__entropi = {
			engine,
			version,
			debug: () => engine?.debug()
		};
		console.info(`entropi ${version}`);

		touched();
		openCam();

		return () => {
			clearTimeout(hintT);
			document.removeEventListener('visibilitychange', vis);
			off?.();
			ro?.disconnect();
			engine?.dispose();
			lock?.release().catch(() => {});
		};
	});
</script>

<svelte:head>
	<title>entropi</title>
</svelte:head>

<div class="stage" bind:this={stage}>
	<video bind:this={video} class="src" muted playsinline autoplay></video>
	<canvas bind:this={canvas}></canvas>
	<div class="flash" class:on={flash}></div>
	<Hud
		code={info?.code ?? ''}
		chip={m.chip}
		value={m.value}
		params={m.params}
		gauge={m.gauge}
		ruler={m.ruler}
		{probe}
		probeOn={info?.probe ?? true}
		{hold}
		{toast}
		{message}
		{idle}
		{index}
		{count}
	/>
</div>

<style>
	.stage {
		position: fixed;
		inset: 0;
		background: #000;
		touch-action: none;
		overflow: hidden;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		background: #000;
	}
	.src {
		position: absolute;
		left: 0;
		top: 0;
		width: 2px;
		height: 2px;
		opacity: 0.01;
		pointer-events: none;
	}
	.flash {
		position: absolute;
		inset: 0;
		background: #000;
		opacity: 0;
		pointer-events: none;
		transition: opacity 320ms ease-out;
	}
	.flash.on {
		opacity: 0.9;
		transition: none;
	}
</style>
