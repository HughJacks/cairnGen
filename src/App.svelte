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
		background:
			radial-gradient(circle at top left, rgba(255, 247, 136, 0.26), transparent 38%),
			var(--stage-bg);
	}

	.stage {
		height: 100%;
		min-width: 0;
		padding: 12px;
		box-sizing: border-box;
	}
</style>
