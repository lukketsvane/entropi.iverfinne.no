<script lang="ts">
	import { onMount } from 'svelte';

	let { data, onerror }: { data: Blob; onerror: (message: string) => void } = $props();
	let canvas: HTMLCanvasElement;

	onMount(() => {
		let alive = true;
		let dispose = () => {};

		async function start() {
			try {
				const [THREE, { SparkRenderer, SparkControls, SplatMesh }] = await Promise.all([
					import('three'),
					import('@sparkjsdev/spark')
				]);
				if (!alive) return;
				const scene = new THREE.Scene();
				const camera = new THREE.PerspectiveCamera(65, 1, 0.01, 1000);
				camera.position.set(0, 0, 1.7);
				const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
				renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
				const spark = new SparkRenderer({ renderer });
				scene.add(spark);
				const controls = new SparkControls({ canvas });
				const splat = new SplatMesh({
					fileBytes: new Uint8Array(await data.arrayBuffer()),
					fileName: 'result.splat'
				});
				if (!alive) {
					renderer.dispose();
					return;
				}
				splat.quaternion.set(1, 0, 0, 0);
				scene.add(splat);
				await splat.initialized;
				if (!alive) {
					renderer.dispose();
					return;
				}
				const resize = () => {
					const width = Math.max(1, canvas.clientWidth);
					const height = Math.max(1, canvas.clientHeight);
					renderer.setSize(width, height, false);
					camera.aspect = width / height;
					camera.updateProjectionMatrix();
				};
				const observer = new ResizeObserver(resize);
				observer.observe(canvas);
				resize();
				renderer.setAnimationLoop(() => {
					controls.update(camera);
					renderer.render(scene, camera);
				});
				dispose = () => {
					observer.disconnect();
					renderer.setAnimationLoop(null);
					renderer.dispose();
				};
			} catch {
				if (alive) onerror('3D-visninga kunne ikkje opnast på denne eininga. Du kan framleis laste ned fila.');
			}
		}

		start();
		return () => {
			alive = false;
			dispose();
		};
	});
</script>

<canvas bind:this={canvas} aria-label="Interaktiv 3D-modell" class="viewer"></canvas>

<style>
	.viewer {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
</style>
