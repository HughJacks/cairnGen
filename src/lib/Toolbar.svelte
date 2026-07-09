<script lang="ts">
	import { app, rockColorIndex, ROCK_SIZES, type ToolPanel } from './state.svelte';
	import { ROCK_SVGS } from './rocks';

	const ROCK_IMAGE_URLS = ROCK_SVGS.map(
		(svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
	);

	let fileInput: HTMLInputElement | undefined = $state();
	/** Which panel content to render — kept mounted until the fade-out finishes. */
	let displayPanel = $state<ToolPanel>('none');
	let subOpen = $state(false);
	let showClearDialog = $state(false);
	let clearDialogEl = $state<HTMLDialogElement | null>(null);

	function clearDialog(node: HTMLDialogElement) {
		clearDialogEl = node;
		return () => {
			clearDialogEl = null;
		};
	}

	$effect(() => {
		if (!clearDialogEl) return;
		if (showClearDialog && !clearDialogEl.open) clearDialogEl.showModal();
		else if (!showClearDialog && clearDialogEl.open) clearDialogEl.close();
	});

	function requestClear() {
		showClearDialog = true;
	}

	function cancelClear() {
		showClearDialog = false;
	}

	function confirmClear() {
		showClearDialog = false;
		app.clear();
	}

	$effect(() => {
		if (app.toolPanel !== 'none') {
			displayPanel = app.toolPanel;
			subOpen = true;
		} else {
			subOpen = false;
		}
	});

	function onSubTransitionEnd(event: TransitionEvent) {
		if (event.target !== event.currentTarget || event.propertyName !== 'opacity') return;
		if (!subOpen) displayPanel = 'none';
	}

	function subTabIndex(panel: ToolPanel) {
		return subOpen && displayPanel === panel ? 0 : -1;
	}

	let diceSvg: SVGSVGElement | undefined = $state();

	function rollLayout() {
		// Spin and fill on the same click — no wait for the animation to finish.
		diceSvg?.getAnimations().forEach((a) => a.cancel());
		diceSvg?.animate(
			[
				{ transform: 'rotate(0deg) scale(1)' },
				{ transform: 'rotate(180deg) scale(1.25)' },
				{ transform: 'rotate(360deg) scale(1)' }
			],
			{ duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
		);
		app.generate();
	}

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

<aside class={['dock', { open: subOpen }]} aria-label="Tools">
	<div
		class={['sub', { open: subOpen }]}
		aria-hidden={!subOpen}
		ontransitionend={onSubTransitionEnd}
	>
		<div class="pill sub-pill">
			{#if displayPanel === 'shape'}
				<button
					class="tool cycle-tool shape"
					onclick={() => app.cycleRock(1)}
					title="Cycle shape"
					aria-label="Cycle shape"
					tabindex={subTabIndex('shape')}
				>
					<img src={ROCK_IMAGE_URLS[app.rockIndex]} alt="" />
				</button>
				<button
					class="tool cycle-tool"
					onclick={() => app.cycleSize()}
					title="Cycle size"
					aria-label="Cycle size"
					tabindex={subTabIndex('shape')}
				>
					{ROCK_SIZES[app.sizeIndex].label}
				</button>
				<div class="cluster colors">
					{#each app.availableRockColors as color (color.hex)}
						{@const i = rockColorIndex(color.hex)}
						<button
							class={['dot', { on: app.colorIndex === i }]}
							style:background={color.hex}
							onclick={() => app.selectColor(i)}
							title={color.name}
							aria-label={color.name}
							aria-pressed={app.colorIndex === i}
							tabindex={subTabIndex('shape')}
						></button>
					{/each}
				</div>
			{:else if displayPanel === 'lucky'}
				<button
					class="tool cycle-tool"
					onclick={() => app.cycleSize()}
					title="Cycle size"
					aria-label="Cycle size"
					tabindex={subTabIndex('lucky')}
				>
					{ROCK_SIZES[app.sizeIndex].label}
				</button>
				<button
					class="tool cycle-tool mode"
					onclick={() => app.cycleMode()}
					title={app.mode === 'cluster' ? 'Cluster' : 'Stack'}
					aria-label={app.mode === 'cluster' ? 'Cluster' : 'Stack'}
					tabindex={subTabIndex('lucky')}
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
							tabindex={subTabIndex('lucky')}
						>
							<img src={ROCK_IMAGE_URLS[i]} alt="" />
						</button>
					{/each}
				</div>
				<div class="cluster colors">
					{#each app.availableRockColors as color (color.hex)}
						{@const i = rockColorIndex(color.hex)}
						<button
							class={['dot', { on: app.colorEnabled[i] }]}
							style:background={color.hex}
							onclick={() => app.toggleColor(i)}
							title={color.name}
							aria-label={color.name}
							aria-pressed={app.colorEnabled[i]}
							tabindex={subTabIndex('lucky')}
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

		<div class="lucky-pill">
			<button
				class="tool icon-tool lucky-roll"
				onclick={rollLayout}
				title="Roll layout"
				aria-label="Roll layout"
			>
				<svg bind:this={diceSvg} viewBox="0 0 16 16" aria-hidden="true">
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
			<button
				class={['tool icon-tool lucky-settings', { active: app.toolPanel === 'lucky' }]}
				onclick={() => app.toggleLuckySettings()}
				aria-pressed={app.toolPanel === 'lucky'}
				title="Roll settings"
				aria-label="Roll settings"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M2 4.5h12M2 8h12M2 11.5h12"
						stroke="currentColor"
						stroke-width="1.3"
						stroke-linecap="round"
						fill="none"
					/>
					<circle cx="5" cy="4.5" r="1.2" fill="currentColor" />
					<circle cx="11" cy="8" r="1.2" fill="currentColor" />
					<circle cx="7" cy="11.5" r="1.2" fill="currentColor" />
				</svg>
			</button>
		</div>

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
		<button
			class="tool icon-tool clear"
			onclick={requestClear}
			title="Clear the artboard"
			aria-label="Clear the artboard"
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

<dialog
	class="modal"
	aria-label="Clear artboard"
	{@attach clearDialog}
	onclose={cancelClear}
	onclick={(e) => {
		if (e.target === e.currentTarget) cancelClear();
	}}
>
	<div class="modal-body">
		<div class="modal-actions">
			<button class="modal-btn ghost" onclick={cancelClear}>Cancel</button>
			<button class="modal-btn danger" onclick={confirmClear}>Clear</button>
		</div>
	</div>
</dialog>

<style>
	.dock {
		position: absolute;
		left: 50%;
		bottom: 20px;
		transform: translateX(-50%);
		z-index: 20;
		pointer-events: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
		width: fit-content;
		max-width: calc(100% - 24px);
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
		flex: 0 0 auto;
	}

	.sub {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		max-width: calc(100vw - 24px);
		opacity: 0;
		pointer-events: none;
		transition: opacity 180ms ease;
	}

	.sub.open {
		opacity: 1;
		pointer-events: auto;
	}

	.sub-pill {
		min-width: 0;
		max-width: 100%;
		overflow: visible;
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

	.lucky-pill {
		display: inline-flex;
		align-items: center;
		gap: 0;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--ink) 4%, transparent);
		flex: 0 0 auto;
		overflow: hidden;
	}

	.lucky-pill .tool {
		width: 28px;
		min-width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 0;
	}

	.lucky-pill .tool:first-child {
		border-radius: 999px 0 0 999px;
	}

	.lucky-pill .tool:last-child {
		border-radius: 0 999px 999px 0;
	}

	.lucky-pill .tool:hover:not(:disabled) {
		background: color-mix(in srgb, var(--ink) 7%, transparent);
	}

	.lucky-pill .tool.active {
		color: var(--paper);
		background: var(--ink);
	}

	.lucky-pill .tool svg {
		width: 14px;
		height: 14px;
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

	.modal {
		width: fit-content;
		max-width: none;
		box-sizing: border-box;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: var(--paper);
		color: var(--ink);
		box-shadow: 0 12px 48px rgba(16, 26, 49, 0.28);
	}

	.modal::backdrop {
		background: rgba(16, 26, 49, 0.42);
		backdrop-filter: blur(2px);
	}

	.modal-body {
		padding: 10px;
	}

	.modal-actions {
		display: flex;
		justify-content: center;
		gap: 6px;
	}

	.modal-btn {
		font: inherit;
		height: 32px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 600;
		border-radius: 4px;
		cursor: pointer;
		transition:
			transform 120ms ease,
			opacity 120ms ease,
			background-color 120ms ease;
	}

	.modal-btn.ghost {
		color: var(--ink);
		background: none;
		border: 1px solid var(--border);
	}

	.modal-btn.ghost:hover {
		border-color: var(--ink);
	}

	.modal-btn.danger {
		color: var(--paper);
		background: #ed4e3d;
		border: 1px solid #ed4e3d;
	}

	.modal-btn.danger:hover {
		transform: translateY(-1px);
		opacity: 0.92;
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

		.sub {
			bottom: calc(100% + 6px);
		}

		.pill {
			height: 42px;
			padding: 5px 6px;
		}
	}
</style>
