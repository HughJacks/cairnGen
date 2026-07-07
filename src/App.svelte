<script lang="ts">
	import Toolbar from './lib/Toolbar.svelte';
	import Canvas from './lib/Canvas.svelte';
</script>

<div class="app">
	<Toolbar />
	<main class="stage">
		<Canvas />
	</main>
</div>

<style>
	.app {
		display: flex;
		height: 100%;
		overflow: hidden;
		background:
			radial-gradient(circle at top left, rgba(255, 247, 136, 0.26), transparent 38%),
			var(--stage-bg);
	}

	.stage {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 12px;
		box-sizing: border-box;
	}
</style>
