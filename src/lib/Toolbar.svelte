<script lang="ts">
	import { app } from './state.svelte';
	import { ROCK_SVGS } from './rocks';
</script>

<div class="toolbar">
	<button class="mode" onclick={() => app.toggleMode()} title="Mode: {app.mode} — click to toggle">
		{#if app.mode === 'cluster'}
			<svg viewBox="0 0 16 16" aria-label="Cluster mode">
				<circle cx="5" cy="6" r="2.4" />
				<circle cx="11.2" cy="4.8" r="2.4" />
				<circle cx="8.4" cy="11.2" r="2.4" />
			</svg>
		{:else}
			<svg viewBox="0 0 16 16" aria-label="Stack mode">
				<circle cx="8" cy="2.8" r="2.4" />
				<circle cx="8" cy="8" r="2.4" />
				<circle cx="8" cy="13.2" r="2.4" />
			</svg>
		{/if}
	</button>

	<span class="divider"></span>

	<button class="aspect" onclick={() => app.cycleAspect()} title="Aspect ratio — click to cycle">
		{app.aspect}
	</button>

	<span class="divider"></span>

	<div
		class="color"
		style:background={app.nextColor.hex}
		title="Next fill: {app.nextColor.name}"
	></div>

	<button
		class="rock"
		onclick={() => app.cycleRock(1)}
		title="Rock {app.rockIndex + 1} — click to cycle, scroll canvas to rotate"
	>
		<span class="rock-shape" style:transform="rotate({app.rotation}deg)">
			{@html ROCK_SVGS[app.rockIndex]}
		</span>
	</button>

	<span class="divider"></span>

	<button class="size" onclick={() => app.cycleSize()} title="Rock size — click to cycle">
		{app.rockSize.label}
	</button>
</div>

<style>
	.toolbar {
		position: absolute;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		background: var(--paper);
		border: 1px solid var(--border);
		border-radius: 999px;
		box-shadow: 0 4px 20px rgba(16, 26, 49, 0.16);
	}

	.mode {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 5px;
		color: var(--ink);
		background: none;
		border: 1px solid var(--border);
		border-radius: 50%;
		cursor: pointer;
	}

	.mode:hover {
		border-color: var(--ink);
	}

	.mode svg {
		width: 100%;
		height: 100%;
		fill: currentColor;
	}

	.aspect {
		padding: 5px 10px;
		font: inherit;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--paper);
		background: var(--ink);
		border: none;
		border-radius: 999px;
		cursor: pointer;
	}

	.divider {
		width: 1px;
		height: 18px;
		background: var(--border);
	}

	.color {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1px solid var(--border);
	}

	.rock {
		height: 28px;
		width: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--ink);
	}

	.rock-shape {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.rock :global(svg) {
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
	}

	.rock :global(svg path) {
		fill: currentColor;
	}

	.size {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
		background: none;
		border: 1px solid var(--border);
		border-radius: 50%;
		cursor: pointer;
	}

	.size:hover {
		border-color: var(--ink);
	}
</style>
