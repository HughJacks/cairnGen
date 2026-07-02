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
	}

	.stage {
		height: 100%;
		background: var(--stage-bg);
	}
</style>
