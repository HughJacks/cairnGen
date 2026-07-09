<script lang="ts">
	import { app, ROCK_COLORS, ROCK_SIZES } from './state.svelte';
	import { ROCK_SVGS } from './rocks';

	const ROCK_IMAGE_URLS = ROCK_SVGS.map(
		(svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
	);

	let fileInput: HTMLInputElement | undefined = $state();

	function readAsDataURL(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	async function onImagePicked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (!files.length) return;
		const srcs = await Promise.all(files.map(readAsDataURL));
		app.addImages(srcs);
	}
</script>

<aside class={['dock', { open: app.toolPanel !== 'none' }]} aria-label="Tools">
	<div class={['sub', { open: app.toolPanel !== 'none' }]} aria-hidden={app.toolPanel === 'none'}>
		<div class="pill sub-pill">
			{#if app.toolPanel === 'shape'}
				<button
					class="tool cycle-tool shape"
					onclick={() => app.cycleRock(1)}
					title="Cycle shape"
					aria-label="Cycle shape"
					tabindex={app.toolPanel === 'shape' ? 0 : -1}
				>
					<img src={ROCK_IMAGE_URLS[app.rockIndex]} alt="" />
				</button>
				<button
					class="tool cycle-tool"
					onclick={() => app.cycleSize()}
					title="Cycle size"
					aria-label="Cycle size"
					tabindex={app.toolPanel === 'shape' ? 0 : -1}
				>
					{ROCK_SIZES[app.sizeIndex].label}
				</button>
				<div class="cluster colors">
					{#each ROCK_COLORS as color, i (color.hex)}
						<button
							class={['dot', { on: app.colorIndex === i }]}
							style:background={color.hex}
							onclick={() => app.selectColor(i)}
							title={color.name}
							aria-label={color.name}
							aria-pressed={app.colorIndex === i}
							tabindex={app.toolPanel === 'shape' ? 0 : -1}
						></button>
					{/each}
				</div>
			{:else if app.toolPanel === 'lucky'}
				<button
					class="tool cycle-tool"
					onclick={() => app.cycleSize()}
					title="Cycle size"
					aria-label="Cycle size"
					tabindex={app.toolPanel === 'lucky' ? 0 : -1}
				>
					{ROCK_SIZES[app.sizeIndex].label}
				</button>
				<button
					class="tool cycle-tool mode"
					onclick={() => app.cycleMode()}
					title={app.mode === 'cluster' ? 'Cluster' : 'Stack'}
					aria-label={app.mode === 'cluster' ? 'Cluster' : 'Stack'}
					tabindex={app.toolPanel === 'lucky' ? 0 : -1}
				>
					{#if app.mode === 'cluster'}
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<circle cx="5" cy="6" r="2.4" fill="currentColor" />
							<circle cx="11.2" cy="4.8" r="2.4" fill="currentColor" />
							<circle cx="8.4" cy="11.2" r="2.4" fill="currentColor" />
						</svg>
					{:else}
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<circle cx="8" cy="2.8" r="2.4" fill="currentColor" />
							<circle cx="8" cy="8" r="2.4" fill="currentColor" />
							<circle cx="8" cy="13.2" r="2.4" fill="currentColor" />
						</svg>
					{/if}
				</button>
				<div class="cluster">
					{#each ROCK_SVGS as _svg, i (i)}
						<button
							class={['shape', { on: app.shapeEnabled[i] }]}
							onclick={() => app.toggleShape(i)}
							title="Shape {i + 1}"
							aria-label="Shape {i + 1}"
							aria-pressed={app.shapeEnabled[i]}
							tabindex={app.toolPanel === 'lucky' ? 0 : -1}
						>
							<img src={ROCK_IMAGE_URLS[i]} alt="" />
						</button>
					{/each}
				</div>
				<div class="cluster colors">
					{#each ROCK_COLORS as color, i (color.hex)}
						<button
							class={['dot', { on: app.colorEnabled[i] }]}
							style:background={color.hex}
							onclick={() => app.toggleColor(i)}
							title={color.name}
							aria-label={color.name}
							aria-pressed={app.colorEnabled[i]}
							tabindex={app.toolPanel === 'lucky' ? 0 : -1}
						></button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="pill main-pill">
		<button
			class={['tool icon-tool', { active: app.canvasTool === 'cursor' }]}
			onclick={() => app.selectCursorTool()}
			aria-pressed={app.canvasTool === 'cursor'}
			title="Select"
			aria-label="Select"
		>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<path
					d="M3.2 2.4l9.2 5.1-4.1.7-1.6 4.4z"
					fill="currentColor"
					stroke="currentColor"
					stroke-width="0.6"
					stroke-linejoin="round"
				/>
			</svg>
		</button>

		<button
			class={['tool icon-tool shape-tool', { active: app.canvasTool === 'shape' }]}
			onclick={() => app.selectShapeTool()}
			aria-pressed={app.canvasTool === 'shape'}
			title="Add shape"
			aria-label="Add shape"
		>
			<img src={ROCK_IMAGE_URLS[2]} alt="" />
		</button>

		<button
			class={[
				'tool icon-tool dice-tool',
				{ active: app.canvasTool === 'lucky', armed: app.toolPanel === 'lucky' }
			]}
			onclick={() => app.toggleLuckyTool()}
			aria-pressed={app.canvasTool === 'lucky'}
			title={app.toolPanel === 'lucky' ? 'Roll layout' : "I'm feeling lucky"}
			aria-label={app.toolPanel === 'lucky' ? 'Roll layout' : "I'm feeling lucky"}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<rect
					x="2.5"
					y="2.5"
					width="11"
					height="11"
					rx="2"
					stroke="currentColor"
					stroke-width="1.3"
					fill="none"
				/>
				<circle cx="5.5" cy="5.5" r="1.1" fill="currentColor" />
				<circle cx="8" cy="8" r="1.1" fill="currentColor" />
				<circle cx="10.5" cy="10.5" r="1.1" fill="currentColor" />
			</svg>
		</button>

		<button class="tool" onclick={() => app.cycleAspect()} title="Cycle aspect ratio">
			{app.aspect}
		</button>

		<span class="sep" aria-hidden="true"></span>

		<input
			{@attach (node) => void (fileInput = node)}
			type="file"
			accept="image/*"
			multiple
			onchange={onImagePicked}
			hidden
		/>
		<div class="cluster thumbs">
			{#each app.images as img (img.id)}
				<div class="thumb-wrap" class:editing={app.imageEditId === img.id}>
					<div class="thumb">
						<img src={img.src} alt="" />
					</div>
					<button
						class="thumb-edit"
						onclick={() => app.startImageEdit(img.id)}
						title="Edit image mask"
						aria-label="Edit image mask"
					>
						Edit
					</button>
					<button
						class="thumb-remove"
						onclick={() => app.removeImage(img.id)}
						title="Remove image"
						aria-label="Remove image"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path
								d="M4 4l8 8M12 4l-8 8"
								stroke="currentColor"
								stroke-width="1.8"
								fill="none"
								stroke-linecap="round"
							/>
						</svg>
					</button>
				</div>
			{/each}
			<button
				class="thumb add"
				onclick={() => fileInput?.click()}
				title="Upload images"
				aria-label="Upload images"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M8 3.5v9M3.5 8h9"
						stroke="currentColor"
						stroke-width="1.5"
						fill="none"
						stroke-linecap="round"
					/>
				</svg>
			</button>
		</div>

		<span class="sep" aria-hidden="true"></span>

		<button
			class="tool icon-tool"
			onclick={() => app.undo()}
			disabled={!app.canUndo}
			title="Undo (⌘Z)"
			aria-label="Undo"
		>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<path
					d="M4 8h7.5M4 8l2.5-2.5M4 8l2.5 2.5"
					stroke="currentColor"
					stroke-width="1.3"
					fill="none"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
		<button
			class="tool icon-tool"
			onclick={() => app.redo()}
			disabled={!app.canRedo}
			title="Redo (⌘⇧Z)"
			aria-label="Redo"
		>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<path
					d="M12 8H4.5M12 8L9.5 5.5M12 8L9.5 10.5"
					stroke="currentColor"
					stroke-width="1.3"
					fill="none"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
		<button class="tool clear" onclick={() => app.clear()} title="Clear the artboard">Clear</button>
		<button
			class="tool icon-tool solid"
			onclick={() => app.exportPng()}
			title="Download"
			aria-label="Download"
		>
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<path
					d="M8 2v8M5 7l3 3 3-3M2.5 12.5v1h11v-1"
					stroke="currentColor"
					stroke-width="1.3"
					fill="none"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
	</div>
</aside>

<style>
	.dock {
		position: absolute;
		left: 50%;
		bottom: 20px;
		transform: translateX(-50%);
		z-index: 20;
		pointer-events: none;
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		align-content: center;
		gap: 0;
		width: fit-content;
		max-width: calc(100% - 24px);
	}

	.dock.open {
		/* Side-by-side or stacked: same gap either way. */
		gap: 8px;
	}

	.pill {
		pointer-events: auto;
		display: flex;
		align-items: center;
		width: max-content;
		max-width: 100%;
		height: 44px;
		box-sizing: border-box;
		gap: 4px;
		padding: 6px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--paper) 92%, transparent);
		border: 1px solid var(--border);
		box-shadow: 0 8px 28px rgba(16, 26, 49, 0.14);
		backdrop-filter: blur(10px);
		overflow: visible;
		flex: 0 0 auto;
	}

	.main-pill {
		/* When wrapping, keep the main bar on the lower row. */
		order: 1;
	}

	.sub {
		order: 0;
		display: grid;
		grid-template-columns: 0fr;
		transition: grid-template-columns 220ms ease;
		min-width: 0;
		max-width: 100%;
		/* Don't shrink — wrap onto the row above the main bar instead. */
		flex: 0 0 auto;
	}

	.sub.open {
		grid-template-columns: 1fr;
	}

	.sub-pill {
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		opacity: 0;
		transform: translateX(8px);
		pointer-events: none;
		transition:
			opacity 180ms ease,
			transform 220ms ease;
	}

	.sub.open .sub-pill {
		opacity: 1;
		transform: translateX(0);
		overflow: visible;
		pointer-events: auto;
	}

	.sep {
		width: 1px;
		height: 18px;
		margin: 0 4px;
		background: var(--border);
		flex: 0 0 auto;
		align-self: center;
	}

	.cluster {
		display: flex;
		align-items: center;
		width: max-content;
		gap: 2px;
		flex: 0 0 auto;
	}

	.cluster.colors {
		gap: 6px;
		padding: 2px 4px;
	}

	.dot {
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 50%;
		cursor: pointer;
		opacity: 0.35;
		flex: 0 0 auto;
		transition:
			opacity 100ms ease,
			box-shadow 100ms ease;
	}

	.dot.on {
		opacity: 1;
		box-shadow:
			0 0 0 1px var(--paper),
			0 0 0 2px var(--ink);
	}

	.shape {
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2px;
		background: none;
		border: none;
		cursor: pointer;
		opacity: 0.25;
		transition: opacity 100ms ease;
		flex: 0 0 auto;
	}

	.shape.on {
		opacity: 1;
	}

	.shape img {
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
	}

	.tool {
		font: inherit;
		height: 32px;
		min-width: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink);
		background: transparent;
		border: 1px solid transparent;
		cursor: pointer;
		flex: 0 0 auto;
		white-space: nowrap;
		transition:
			border-color 100ms ease,
			background-color 100ms ease,
			color 100ms ease,
			opacity 100ms ease;
	}

	.tool:hover:not(:disabled) {
		background: color-mix(in srgb, var(--ink) 5%, transparent);
	}

	.tool.active {
		color: var(--paper);
		background: var(--ink);
	}

	.tool:disabled {
		opacity: 0.3;
		cursor: default;
	}

	/* Outlined cycle controls — must follow .tool so the border isn't wiped. */
	.tool.cycle-tool {
		box-sizing: border-box;
		width: 32px;
		min-width: 32px;
		height: 32px;
		padding: 0;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0;
		text-align: center;
		border: 1px solid var(--border);
	}

	.tool.cycle-tool:hover {
		border-color: var(--ink);
	}

	.tool.cycle-tool.shape {
		padding: 4px;
	}

	.tool.cycle-tool.shape img {
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
		display: block;
	}

	.tool.cycle-tool.mode svg {
		width: 15px;
		height: 15px;
		display: block;
	}

	.icon-tool {
		padding: 0;
		width: 32px;
	}

	.icon-tool svg {
		width: 15px;
		height: 15px;
	}

	.shape-tool img {
		width: 18px;
		height: 18px;
		object-fit: contain;
		display: block;
		/* Rock SVGs are dark ink; invert when the tool is active (ink bg). */
		filter: none;
	}

	.shape-tool.active img {
		filter: invert(1);
	}

	.dice-tool.armed {
		animation: dice-nudge 1.1s ease-in-out infinite;
	}

	.dice-tool.armed svg {
		animation: dice-roll 1.1s ease-in-out infinite;
	}

	@keyframes dice-nudge {
		0%,
		100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--ink) 0%, transparent);
		}
		50% {
			box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 12%, transparent);
		}
	}

	@keyframes dice-roll {
		0%,
		100% {
			transform: rotate(0deg) scale(1);
		}
		25% {
			transform: rotate(-12deg) scale(1.06);
		}
		75% {
			transform: rotate(12deg) scale(1.06);
		}
	}

	.tool.solid {
		background: var(--ink);
		color: var(--paper);
		border-color: var(--ink);
	}

	.tool.solid:hover:not(:disabled) {
		opacity: 0.88;
	}

	.tool.clear {
		color: #ed4e3d;
	}

	.tool.clear:hover {
		background: color-mix(in srgb, #ed4e3d 8%, transparent);
	}

	.thumbs {
		gap: 6px;
		padding: 0;
	}

	.thumb-wrap {
		position: relative;
		padding: 0;
		margin: 0;
		flex: 0 0 auto;
	}

	.thumb-wrap.editing .thumb {
		box-shadow:
			0 0 0 1px var(--paper),
			0 0 0 2px var(--ink);
		border-color: var(--ink);
	}

	.thumb-edit {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font: inherit;
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--paper);
		background: rgba(16, 26, 49, 0.55);
		border: none;
		border-radius: 3px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 100ms ease;
	}

	.thumb-wrap:hover .thumb-edit,
	.thumb-wrap.editing .thumb-edit {
		opacity: 1;
	}

	.thumb-remove {
		position: absolute;
		top: 0;
		right: 0;
		width: 14px;
		height: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border-radius: 2px;
		border: 1px solid var(--paper);
		background: var(--ink);
		color: var(--paper);
		cursor: pointer;
	}

	.thumb-remove svg {
		width: 8px;
		height: 8px;
	}

	.thumb-remove:hover {
		background: #ed4e3d;
	}

	.thumb {
		width: 32px;
		height: 32px;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--paper);
		overflow: hidden;
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		pointer-events: none;
	}

	.thumb.add {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--ink);
		border-style: dashed;
		opacity: 0.6;
		cursor: pointer;
		padding: 0;
	}

	.thumb.add svg {
		width: 12px;
		height: 12px;
	}

	.thumb.add:hover {
		opacity: 1;
		border-color: var(--ink);
	}

	@media (max-width: 760px) {
		.dock {
			bottom: 12px;
		}

		.dock.open {
			gap: 6px;
		}

		.pill {
			height: 42px;
			padding: 5px 6px;
		}
	}
</style>
