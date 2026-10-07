<script lang="ts">
	import { onMount } from 'svelte';
	import { updated } from '$app/state';
	import { version } from '$app/env';
	import Picker from '../lib/hud/Picker.svelte';
	import { Engine } from '../lib/engine/engine';
	import { CamError, cameraAlive, startCamera } from '../lib/engine/camera';
	import type { SetupInfo } from '../lib/engine/types';
	import { attachGestures } from '../lib/gesture';
	import { haptic } from '../lib/haptics';
	import { SETUPS } from '../lib/setups';

	let stage: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let video: HTMLVideoElement;

	/** Ingen tekst og ingen HUD: berre biletet. Kameraet sin tilstand går til konsollen. */
	type Status = 'boot' | 'needtap' | 'ready' | 'failed';
	let status: Status = 'boot';

	let index = $state(0);
	let flash = $state(false);
	let picker = $state(false);
	let seenIds = $state<string[]>([]);
	let avail = $state<boolean[]>([]);
	let infos = $state<readonly SetupInfo[]>([]);

	let engine: Engine | null = null;
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

	const seen = new Set((store.get('entropi.seen') ?? '').split(',').filter(Boolean));
	let pressing = false;
	let pressOk = false;

	/**
	 * To usynlege felt: oppe til venstre (langt trykk: veljaren) og nede til høgre (trykk: neste grovkorning).
	 * Dei vert ikkje brukte til å trykkje på biletet.
	 */
	function corner(px: number, py: number, w: number, h: number) {
		return (px < 150 && py < 112) || (px > w - 190 && py > h - 124);
	}

	function openPicker() {
		if (!engine || status !== 'ready') return false;
		infos = engine.list;
		avail = engine.list.map((_, k) => engine!.available(k));
		seenIds = [...seen];
		picker = true;
		haptic([10, 30, 10]);
		return true;
	}

	function pick(i: number) {
		picker = false;
		if (!engine) return;
		if (i !== engine.index) {
			engine.go(i);
			blink();
		}
		haptic(12);
	}

	function blink() {
		flash = true;
		setTimeout(() => (flash = false), 110);
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
			// 'needtap': iOS vil ha eit trykk før kameraet startar. Alt anna er feil, og står i konsollen.
			if (e instanceof CamError && e.kind === 'denied') status = 'needtap';
			else {
				status = 'failed';
				console.error('kamera', e);
			}
		}
	}

	onMount(() => {
		let off: (() => void) | null = null;
		let ro: ResizeObserver | null = null;

		try {
			engine = new Engine(canvas, video, SETUPS, {
				onSetup: (i, idx) => {
					index = idx;
					store.set('entropi.setup', i.id);
					pressing = false;
					if (!seen.has(i.id)) {
						seen.add(i.id);
						store.set('entropi.seen', [...seen].join(','));
					}
					seenIds = [...seen];
					if (engine) avail = engine.list.map((_, k) => engine!.available(k));
				},
				onStall: () => {
					if (!cameraAlive(video)) openCam();
				},
				onFatal: (e) => {
					status = 'failed';
					console.error('motor', e);
				}
			});
		} catch (e) {
			status = 'failed';
			console.error('motor', e);
			return;
		}

		const saved = store.get('entropi.setup');
		if (saved) engine.goId(saved);

		ro = new ResizeObserver(() => {
			const r = stage.getBoundingClientRect();
			engine?.resize(r.width, r.height, window.devicePixelRatio || 1);
		});
		ro.observe(stage);
		const r0 = stage.getBoundingClientRect();
		engine.resize(r0.width, r0.height, window.devicePixelRatio || 1);

		off = attachGestures(stage, {
			holdMs: 1200,
			onLong: (x, y) => {
				if (picker) return false;
				const r = stage.getBoundingClientRect();
				// langt trykk oppe til venstre: veljaren
				if (x * r.width < 150 && y * r.height < 112) return openPicker();
				return false;
			},
			onHold: (dir) => {
				if (dir < 0) engine?.prev();
				else engine?.next();
				blink();
				haptic([14, 40, 14]);
			},
			onPoint: (x, y, down) => {
				if (status !== 'ready' || !engine) return;
				if (down && !pressing) {
					const r = stage.getBoundingClientRect();
					pressOk = engine.pressable && !corner(x * r.width, y * r.height, r.width, r.height);
				}
				if (!pressOk) return;
				pressing = down;
				engine.touch(x, y, down);
			},
			onTap: (x, y) => {
				if (status !== 'ready') {
					openCam();
					return;
				}
				const r = stage.getBoundingClientRect();
				const px = x * r.width;
				const py = y * r.height;
				// trykk nede til høgre: neste grovkorning
				if (px > r.width - 190 && py > r.height - 124 && engine?.canCycle) {
					engine.cycle();
					haptic(8);
					return;
				}
				engine?.tap(x, y);
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

		openCam();

		return () => {
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
	<Picker open={picker} {infos} {index} seen={seenIds} {avail} onpick={pick} onclose={() => (picker = false)} />
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
