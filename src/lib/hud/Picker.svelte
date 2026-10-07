<script lang="ts">
	import { tick } from 'svelte';
	import type { SetupGroup, SetupInfo } from '../engine/types';

	interface Props {
		open: boolean;
		infos: readonly SetupInfo[];
		/** posisjonen til oppsettet som køyrer */
		index: number;
		/** id-ar brukaren har vore innom, resten får ein liten prikk */
		seen: readonly string[];
		/** false for oppsett som ikkje kan køyre på denne eininga */
		avail: readonly boolean[];
		onpick(i: number): void;
		onclose(): void;
	}

	let { open, infos, index, seen, avail, onpick, onclose }: Props = $props();

	const GROUPS: { id: SetupGroup; label: string; sub: string }[] = [
		{ id: 'rom', label: 'ROM', sub: 'Kor mykje er det i eitt bilete?' },
		{ id: 'tid', label: 'TIDSLØP', sub: 'Kva endrar seg, og kor fort?' },
		{ id: 'dyn', label: 'DYNAMIKK', sub: 'System som køyrer av seg sjølve.' }
	];

	const groups = $derived(
		GROUPS.map((g) => ({
			...g,
			items: infos.map((info, i) => ({ info, i })).filter((o) => o.info.group === g.id)
		})).filter((g) => g.items.length > 0)
	);

	let scroller = $state<HTMLElement | undefined>();

	$effect(() => {
		if (!open) return;
		tick().then(() => scroller?.querySelector('.tile.cur')?.scrollIntoView({ block: 'center' }));
	});

	const stop = (e: Event) => e.stopPropagation();
	const pad = (n: number) => String(n).padStart(2, '0');
</script>

{#if open}
	<div
		class="pick"
		role="dialog"
		aria-modal="true"
		aria-label="Oppstillingar"
		tabindex="-1"
		onpointerdown={stop}
		onpointermove={stop}
		onpointerup={stop}
		onpointercancel={stop}
	>
		<header>
			<span class="ttl">OPPSTILLINGAR</span>
			<span class="num">{pad(index + 1)}/{infos.length}</span>
			<button class="x" aria-label="Lukk" onclick={onclose}>
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2L14 14M14 2L2 14" /></svg>
			</button>
		</header>
		<div class="scroll" data-scroll bind:this={scroller}>
			{#each groups as grp (grp.id)}
				<section>
					<h2><span>{grp.label}</span><i>{grp.sub}</i></h2>
					<div class="grid">
						{#each grp.items as it (it.info.id)}
							<button
								class="tile"
								class:cur={it.i === index}
								disabled={!avail[it.i]}
								aria-current={it.i === index ? 'true' : undefined}
								onclick={() => onpick(it.i)}
							>
								<b>{it.info.code}</b>
								<span>{it.info.name}</span>
								{#if !seen.includes(it.info.id)}<u></u>{/if}
							</button>
						{/each}
					</div>
				</section>
			{/each}
			<div class="end"></div>
		</div>
	</div>
{/if}

<style>
	.pick {
		position: absolute;
		inset: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		background: rgba(0, 0, 0, 0.7);
		-webkit-backdrop-filter: blur(26px) saturate(1.25);
		backdrop-filter: blur(26px) saturate(1.25);
		padding-top: env(safe-area-inset-top, 0px);
		animation: in 240ms var(--ease) both;
		color: var(--fg);
		outline: none;
	}
	@keyframes in {
		from {
			opacity: 0;
			transform: scale(1.015);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	header {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 56px;
		padding: 0 14px 0 22px;
		flex: none;
	}
	.ttl {
		font-family: var(--hud-font);
		font-size: 11px;
		letter-spacing: 0.18em;
	}
	.num {
		font-family: var(--hud-font);
		font-size: 11px;
		letter-spacing: 0.06em;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
		margin-left: auto;
	}
	.x {
		width: 44px;
		height: 44px;
		border: 0;
		background: transparent;
		display: grid;
		place-items: center;
		color: var(--fg);
		cursor: pointer;
	}
	.x path {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4px;
		stroke-linecap: round;
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		touch-action: pan-y;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		padding: 4px 20px 0;
		scrollbar-width: none;
	}
	.scroll::-webkit-scrollbar {
		display: none;
	}
	section {
		margin-bottom: 22px;
	}
	h2 {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin: 6px 2px 11px;
		font-weight: 400;
	}
	h2 span {
		font-family: var(--hud-font);
		font-size: 10px;
		letter-spacing: 0.22em;
		color: var(--fg);
	}
	h2 i {
		font-style: normal;
		font-family: var(--ui-font);
		font-size: 12px;
		color: var(--dim);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 9px;
	}
	.tile {
		--arm: 9px;
		--c: rgba(255, 255, 255, 0.5);
		position: relative;
		height: 78px;
		padding: 12px 12px 11px;
		border: 0;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.05);
		color: var(--fg);
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-items: flex-start;
		text-align: left;
		cursor: pointer;
		transition:
			transform 140ms var(--ease),
			background 160ms linear;
		/* fire hjørne, som i søkjaren */
		background-image:
			linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)),
			linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)),
			linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)),
			linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c));
		background-repeat: no-repeat;
		background-size:
			var(--arm) 1px,
			1px var(--arm),
			var(--arm) 1px,
			1px var(--arm),
			var(--arm) 1px,
			1px var(--arm),
			var(--arm) 1px,
			1px var(--arm);
		background-position:
			6px 6px,
			6px 6px,
			calc(100% - 6px) 6px,
			calc(100% - 6px) 6px,
			6px calc(100% - 6px),
			6px calc(100% - 6px),
			calc(100% - 6px) calc(100% - 6px),
			calc(100% - 6px) calc(100% - 6px);
	}
	.tile:active {
		transform: scale(0.965);
		background-color: rgba(255, 255, 255, 0.12);
	}
	.tile.cur {
		--c: #fff;
		background-color: rgba(255, 255, 255, 0.16);
	}
	.tile:disabled {
		opacity: 0.32;
	}
	.tile b {
		font-family: var(--hud-font);
		font-weight: 400;
		font-size: 16px;
		letter-spacing: 0.04em;
		line-height: 1;
		margin: 5px 0 0 5px;
	}
	.tile span {
		font-family: var(--ui-font);
		font-size: 12px;
		line-height: 1.1;
		color: var(--dim);
		margin-left: 5px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tile.cur span {
		color: var(--fg);
	}
	.tile u {
		position: absolute;
		top: 12px;
		right: 13px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
	}
	.end {
		height: calc(env(safe-area-inset-bottom, 0px) + 28px);
	}
	@media (prefers-reduced-motion: reduce) {
		.pick {
			animation: none;
		}
		.tile {
			transition: none;
		}
	}
</style>
