<script lang="ts">
	import Toolbar from './lib/Toolbar.svelte';
	import Canvas from './lib/Canvas.svelte';
</script>

<div class="app">
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
			radial-gradient(circle at top left, rgba(255, 247, 136, 0.26), transparent 38%),
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
