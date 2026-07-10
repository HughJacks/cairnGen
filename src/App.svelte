<script lang="ts">
	import Toolbar from './lib/Toolbar.svelte';
	import Canvas from './lib/Canvas.svelte';
	import { app } from './lib/state.svelte';

	const ambient0 = $derived(app.canvasBg ?? '#FFFFFF');
	const accents = $derived(app.enabledBgRockColors.slice(0, 2));
	const ambient1 = $derived(accents[0] ?? ambient0);
	const ambient2 = $derived(accents[1] ?? accents[0] ?? ambient0);
</script>

<div
	class="app"
	style:--ambient-0={ambient0}
	style:--ambient-1={ambient1}
	style:--ambient-2={ambient2}
>
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
		--dock-bottom: 20px;
		--dock-stage-gap: 12px;
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

	.stage {
		height: 100%;
		min-width: 0;
		padding: 20px 12px 12px;
		/* Reserve space for main + sub dock pills stacked — canvas never shifts when a sub opens. */
		padding-bottom: max(
			12px,
			calc(var(--dock-bottom) + var(--dock-stage-gap) + var(--dock-pill) + var(--dock-gap) + var(--dock-pill))
		);
		box-sizing: border-box;
	}

	@media (max-width: 760px) {
		.stage {
			padding-bottom: max(
				12px,
				calc(12px + var(--dock-stage-gap) + 42px + 6px + 42px)
			);
		}
	}
</style>
