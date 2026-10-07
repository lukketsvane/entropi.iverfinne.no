<script lang="ts">
	import { untrack } from 'svelte';

	interface Props {
		code: string;
		chip: string;
		value: string;
		params: string;
		/** 0..1, fyllgrad på batteriet */
		gauge: number;
		/** 0..1, trekanten på linjalen */
		ruler: number;
		/** sondepunkt 0..1, origo øvst til venstre */
		probe: { x: number; y: number };
		probeOn?: boolean;
		/** 0..1, framdrift for to-finger-halde */
		hold: number;
		/** augneblinks-tekst nede, tom = skjult */
		toast: string;
		/** tekst midt på skjermen ved oppstart og feil */
		message: { title: string; body?: string } | null;
		idle: boolean;
		/** 0..n-1, for dei små prikkane under koden */
		index: number;
		count: number;
	}

	let {
		code,
		chip,
		value,
		params,
		gauge,
		ruler,
		probe,
		probeOn = true,
		hold,
		toast,
		message,
		idle,
		index,
		count
	}: Props = $props();

	let W = $state(390);
	let H = $state(844);

	// geometri for sentrumsklynga, proporsjonert etter referansen (landskap) men for portrett
	const u = $derived(Math.min(W, H) * 0.31);
	const bh = $derived(u * 0.82);
	const cx = $derived(W / 2);
	const cy = $derived(H / 2);
	const arm = $derived(u * 0.2);
	const sq = $derived(Math.max(9, u * 0.1));
	const afs = $derived([
		[-0.924 * u, 0],
		[0.924 * u, 0],
		[-0.462 * u, -0.78 * bh],
		[0.462 * u, -0.78 * bh],
		[-0.462 * u, 0.78 * bh],
		[0.462 * u, 0.78 * bh],
		[0, -1.46 * bh],
		[0, 1.46 * bh]
	]);
	const r1 = $derived(u * 0.3);
	const r2 = $derived(u * 0.145);
	const rp = $derived(r1 + 7);
	const C1 = $derived(2 * Math.PI * r1);
	const Cp = $derived(2 * Math.PI * rp);

	// batteri
	const BW = 52;
	const BH = 22;
	const fw = $derived(Math.max(0, Math.min(1, gauge)) * (BW - 6));

	// linjal
	const TW = 196; // breidda på tikkane
	const TX = 24; // venstre marg til første tikk (plass til «−»)
	const RW = TW + TX * 2;
	const ticks = Array.from({ length: 31 }, (_, i) => {
		const c = i === 15;
		const big = i % 5 === 0;
		return { x: TX + (i * TW) / 30, h: c ? 24 : big ? 17 : 11 };
	});
	const mx = $derived(TX + Math.max(0, Math.min(1, ruler)) * TW);

	// bokstavsprang når koden byter
	let shown = $state('');
	let timer = 0;
	$effect(() => {
		const target = code;
		untrack(() => {
			clearInterval(timer);
			if (!shown) {
				shown = target;
				return;
			}
			const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ0123456789';
			let n = 0;
			timer = window.setInterval(() => {
				n++;
				if (n >= 9) {
					clearInterval(timer);
					shown = target;
					return;
				}
				shown = target
					.split('')
					.map((ch, i) => (n > i * 2 + 2 ? ch : glyphs[Math.floor(Math.random() * glyphs.length)]))
					.join('');
			}, 38);
		});
		return () => clearInterval(timer);
	});
</script>

<div class="hud" class:idle bind:clientWidth={W} bind:clientHeight={H}>
	<div class="grid">
		<i class="v" style="left:33.333%"></i>
		<i class="v" style="left:66.666%"></i>
		<i class="h" style="top:33.333%"></i>
		<i class="h" style="top:66.666%"></i>
	</div>

	<svg class="mid" width={W} height={H} viewBox="0 0 {W} {H}" aria-hidden="true">
		<g class="af">
			<path
				d="M{cx - u} {cy - bh + arm}V{cy - bh}H{cx - u + arm}M{cx + u - arm} {cy - bh}H{cx + u}V{cy - bh + arm}M{cx - u} {cy + bh - arm}V{cy + bh}H{cx - u + arm}M{cx + u - arm} {cy + bh}H{cx + u}V{cy + bh - arm}"
			/>
			{#each afs as p}
				<rect x={cx + p[0] - sq / 2} y={cy + p[1] - sq / 2} width={sq} height={sq} />
			{/each}
		</g>

		<g class="probe" style="transform:translate({probe.x * W}px,{probe.y * H}px)">
			{#if probeOn}
				<circle class="ring" r={r1} />
				<circle
					class="ring2"
					r={r1 - 4}
					stroke-dasharray="{(C1 - 12) * 0.47} {(C1 - 12) * 0.03} {(C1 - 12) * 0.47} {(C1 - 12) * 0.03}"
					transform="rotate(-62)"
				/>
				<circle class="inner" r={r2} />
				<path class="inner" d="M{-r2} 0H{r2}" />
			{/if}
			<rect class="dot" x={-sq / 2} y={-sq / 2} width={sq} height={sq} />
			<circle
				class="prog"
				r={rp}
				stroke-dasharray={Cp}
				stroke-dashoffset={Cp * (1 - hold)}
				transform="rotate(-90)"
				style="opacity:{hold > 0 ? 1 : 0}"
			/>
		</g>
	</svg>

	<div class="corner tl">
		<span class="code">{shown}</span>
		<span class="dots">
			{#each Array(count) as _, i}<b class:on={i === index}></b>{/each}
		</span>
	</div>

	<div class="corner tr">
		<span class="chip">{chip}</span>
		<span class="val">{value}</span>
	</div>

	<div class="corner bl">
		<svg width={BW + 5} height={BH} viewBox="0 0 {BW + 5} {BH}" aria-hidden="true">
			<rect class="bat" x="0.75" y="0.75" width={BW - 1.5} height={BH - 1.5} rx="2.5" />
			<rect class="nub" x={BW} y={BH / 2 - 4} width="3.5" height="8" rx="1" />
			<path class="fill" d="M3 3H{3 + Math.max(0, fw - 7)}L{3 + fw} {BH - 3}H3Z" />
		</svg>
	</div>

	<div class="corner br">
		<span class="par">{params}</span>
	</div>

	<div class="ruler" style="width:{RW}px">
		<svg width={RW} height="52" viewBox="0 0 {RW} 52" aria-hidden="true">
			<g class="ticks">
				{#each ticks as t}
					<path d="M{t.x} {30 - t.h / 2}V{30 + t.h / 2}" />
				{/each}
			</g>
			<path class="sign" d="M2 30H11" />
			<path class="sign" d="M{RW - 11} 30H{RW - 2}M{RW - 6.5} 25.5V34.5" />
			<path class="mark" style="transform:translateX({mx}px)" d="M0 41L6 51H-6Z" />
		</svg>
	</div>

	{#if toast}
		{#key toast}
			<div class="toast">{toast}</div>
		{/key}
	{/if}

	{#if message}
		<div class="msg">
			<div class="t">{message.title}</div>
			{#if message.body}<div class="b">{message.body}</div>{/if}
		</div>
	{/if}
</div>

<style>
	.hud {
		position: fixed;
		inset: 0;
		pointer-events: none;
		color: var(--fg);
		--w: 1px;
		--arm: 46px;
		--mx: max(20px, env(safe-area-inset-left));
		--mxr: max(20px, env(safe-area-inset-right));
		--mt: calc(env(safe-area-inset-top, 0px) + 8px);
		--mb: calc(env(safe-area-inset-bottom, 0px) + 10px);
		font-family: var(--hud-font);
	}
	@media (-webkit-min-device-pixel-ratio: 3) {
		.hud {
			--w: 0.67px;
		}
	}

	/* tredjedelsliner */
	.grid i {
		position: absolute;
		background: var(--hair);
		transition: opacity 600ms var(--ease);
	}
	.grid .v {
		top: 0;
		bottom: 0;
		width: var(--w);
	}
	.grid .h {
		left: 0;
		right: 0;
		height: var(--w);
	}
	.idle .grid i {
		opacity: 0;
	}

	/* sentrumsklynga */
	.mid {
		position: absolute;
		inset: 0;
		overflow: visible;
	}
	.mid :global(*) {
		fill: none;
		stroke: var(--line);
		stroke-width: var(--w);
		shape-rendering: geometricPrecision;
	}
	.af {
		transition: opacity 600ms var(--ease);
	}
	.idle .af {
		opacity: 0.35;
	}
	.probe {
		transition: transform 380ms var(--ease);
	}
	.probe .ring {
		stroke-width: calc(var(--w) * 1.3);
	}
	.probe .inner {
		stroke-width: calc(var(--w) * 1.3);
	}
	.probe .dot {
		stroke-width: calc(var(--w) * 1.6);
	}
	.probe .prog {
		stroke: #fff;
		stroke-width: 2.4px;
		stroke-linecap: butt;
		transition: opacity 160ms linear;
		filter: drop-shadow(0 0 3px rgba(255, 255, 255, 0.55));
	}

	/* hjørne: faste armar teikna med ::before og ::after, innhaldet ligg innanfor */
	.corner {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 10px;
		height: 84px;
		text-shadow: var(--halo);
	}
	.corner::before,
	.corner::after {
		content: '';
		position: absolute;
		background: var(--line);
	}
	.corner::before {
		width: var(--arm);
		height: var(--w);
	}
	.corner::after {
		width: var(--w);
		height: var(--arm);
	}
	.tl {
		left: var(--mx);
		top: var(--mt);
		padding-left: 18px;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 9px;
		width: 120px;
	}
	.tl::before,
	.tl::after {
		top: 0;
		left: 0;
	}
	.tr {
		right: var(--mxr);
		top: var(--mt);
		justify-content: flex-end;
		padding-right: 18px;
		width: 200px;
	}
	.tr::before,
	.tr::after {
		top: 0;
		right: 0;
	}
	.bl {
		left: var(--mx);
		bottom: var(--mb);
		padding-left: 18px;
		width: 120px;
	}
	.bl::before,
	.bl::after {
		bottom: 0;
		left: 0;
	}
	.br {
		right: var(--mxr);
		bottom: var(--mb);
		justify-content: flex-end;
		padding-right: 18px;
		width: 200px;
	}
	.br::before,
	.br::after {
		bottom: 0;
		right: 0;
	}

	.code {
		font-size: 23px;
		letter-spacing: 0.04em;
		line-height: 1;
		white-space: nowrap;
	}
	.dots {
		display: flex;
		gap: 5px;
	}
	.dots b {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--dim);
		opacity: 0.55;
		transition: all 240ms var(--ease);
	}
	.dots b.on {
		background: #fff;
		opacity: 1;
		transform: scale(1.35);
	}
	.chip {
		font-size: 15px;
		line-height: 1;
		background: #fff;
		color: #000;
		padding: 5px 8px 5px 9px;
		border-radius: 5px;
		text-shadow: none;
		letter-spacing: 0.02em;
	}
	.val {
		font-size: 23px;
		line-height: 1;
		min-width: 4.1ch;
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.par {
		font-size: 15px;
		line-height: 1;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.bat {
		stroke: #fff;
		stroke-width: 1.5px;
		fill: none;
	}
	.nub {
		fill: #fff;
		stroke: none;
	}
	.fill {
		fill: #fff;
		stroke: none;
	}

	/* linjal */
	.ruler {
		position: absolute;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 104px);
		transform: translateX(-50%);
		height: 52px;
	}
	.ruler svg {
		overflow: visible;
		display: block;
	}
	.ruler .ticks path,
	.ruler .sign {
		stroke: #fff;
		stroke-width: 1.4px;
		fill: none;
	}
	.ruler .mark {
		fill: #fff;
		stroke: none;
		transition: transform 320ms var(--ease);
		filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
	}

	.toast {
		position: absolute;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 176px);
		transform: translateX(-50%);
		width: min(78vw, 330px);
		text-align: center;
		font-family: var(--ui-font);
		font-size: 14px;
		line-height: 1.35;
		letter-spacing: 0.01em;
		color: rgba(255, 255, 255, 0.92);
		text-shadow: var(--halo), 0 0 14px rgba(0, 0, 0, 0.8);
		animation: toast 3.2s var(--ease) both;
	}
	@keyframes toast {
		0% {
			opacity: 0;
			transform: translate(-50%, 6px);
		}
		8% {
			opacity: 1;
			transform: translate(-50%, 0);
		}
		82% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}

	.msg {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, calc(-50% + 78px));
		width: min(80vw, 320px);
		text-align: center;
		text-shadow: var(--halo);
	}
	.msg .t {
		font-size: 13px;
		letter-spacing: 0.08em;
	}
	.msg .b {
		margin-top: 10px;
		font-family: var(--ui-font);
		font-size: 13.5px;
		line-height: 1.4;
		color: var(--dim);
	}

	@media (prefers-reduced-motion: reduce) {
		.probe,
		.ruler .mark,
		.grid i,
		.af {
			transition: none;
		}
		.toast {
			animation-duration: 0.01s;
		}
	}
</style>
