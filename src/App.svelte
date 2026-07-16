<script lang="ts">
	import Toolbar from './lib/Toolbar.svelte';
	import Canvas from './lib/Canvas.svelte';
	import { app } from './lib/state.svelte';
	import peLogo from './assets/PE_Logo_Stacked_Ink.svg';

	const ambient0 = $derived(app.canvasBg ?? '#FFFFFF');
	const accents = $derived(app.enabledBgRockColors.slice(0, 2));
	const ambient1 = $derived(accents[0] ?? ambient0);
	const ambient2 = $derived(accents[1] ?? accents[0] ?? ambient0);

	const BRAND_H = 72;
	/** Extra gap so logo hides before it visually kisses the color bar. */
	const OVERLAP_PAD = 8;

	let brandEl: HTMLImageElement | undefined = $state();
	let logoHidden = $state(false);

	function rectsOverlap(a: DOMRectReadOnly, b: DOMRectReadOnly, pad: number) {
		return !(
			a.right + pad < b.left ||
			a.left - pad > b.right ||
			a.bottom < b.top ||
			a.top > b.bottom
		);
	}

	$effect(() => {
		// Re-run when the top bar mounts/unmounts (image-edit mode).
		void app.imageEditId;

		const brand = brandEl;
		if (!brand) return;

		let barRo: ResizeObserver | undefined;

		const update = () => {
			const bar = document.querySelector('.bg-bar');
			if (!(bar instanceof HTMLElement)) {
				logoHidden = false;
				return;
			}
			logoHidden = rectsOverlap(
				brand.getBoundingClientRect(),
				bar.getBoundingClientRect(),
				OVERLAP_PAD
			);
		};

		const attachBar = () => {
			barRo?.disconnect();
			const bar = document.querySelector('.bg-bar');
			if (bar) {
				barRo = new ResizeObserver(update);
				barRo.observe(bar);
			}
			update();
		};

		const brandRo = new ResizeObserver(update);
		brandRo.observe(brand);
		window.addEventListener('resize', update);
		const raf = requestAnimationFrame(attachBar);

		return () => {
			cancelAnimationFrame(raf);
			brandRo.disconnect();
			barRo?.disconnect();
			window.removeEventListener('resize', update);
		};
	});
</script>

<div
	class="app"
	style:--ambient-0={ambient0}
	style:--ambient-1={ambient1}
	style:--ambient-2={ambient2}
	style:--brand-h="{BRAND_H}px"
>
	<img
		class={['brand', { hidden: logoHidden }]}
		bind:this={brandEl}
		src={peLogo}
		alt="Project Everyone"
	/>
	<main class="stage">
		<Canvas />
	</main>
	<Toolbar />
</div>

<style>
	.app {
		position: relative;
		height: 100%;
		overflow: hidden;
		--dock-pill: 44px;
		--dock-gap: 8px;
		--dock-top: 20px;
		--dock-bottom: 16px;
		--dock-stage-gap: 6px;
		--chrome-bar: 36px;
		background:
			radial-gradient(
				circle at 50% 42%,
				color-mix(in srgb, var(--ambient-0) 12%, transparent),
				transparent 55%
			),
			radial-gradient(
				circle at 18% 78%,
				color-mix(in srgb, var(--ambient-1) 8%, transparent),
				transparent 48%
			),
			radial-gradient(
				circle at 82% 22%,
				color-mix(in srgb, var(--ambient-2) 7%, transparent),
				transparent 45%
			),
			var(--stage-bg);
	}

	.brand {
		position: absolute;
		/* Vertically center with the top color bar. */
		top: calc(var(--dock-top) + (var(--chrome-bar) - var(--brand-h)) / 2);
		left: 20px;
		height: var(--brand-h);
		width: auto;
		pointer-events: none;
		z-index: 20;
		user-select: none;
	}

	.brand.hidden {
		visibility: hidden;
	}

	.stage {
		height: 100%;
		min-width: 0;
		padding: calc(var(--dock-top) + var(--chrome-bar) + var(--dock-stage-gap)) 12px;
		/* Reserve space for main + sub dock pills stacked — canvas never shifts when a sub opens. */
		padding-bottom: max(
			12px,
			calc(var(--dock-bottom) + var(--dock-stage-gap) + var(--dock-pill) + var(--dock-gap) + var(--dock-pill))
		);
		box-sizing: border-box;
	}

	@media (max-width: 760px) {
		.app {
			--dock-top: 12px;
			--dock-bottom: 12px;
		}

		.stage {
			padding-bottom: max(
				12px,
				calc(var(--dock-bottom) + var(--dock-stage-gap) + 42px + 6px + 42px)
			);
		}
	}
</style>
