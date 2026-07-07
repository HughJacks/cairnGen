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
		// Reset so re-picking the same file still fires a change event.
		input.value = '';
		if (!files.length) return;
		const srcs = await Promise.all(files.map(readAsDataURL));
		app.addImages(srcs);
	}
</script>

<aside class="toolbar">
	<span class="brand">Project Everyone</span>

	<div class="group">
		<span class="label">Mode</span>
		<div class="row segmented">
			<button
				class={['chip icon-chip', { active: app.designMode === 'place' }]}
				onclick={() => app.designMode !== 'place' && app.toggleDesignMode()}
				aria-pressed={app.designMode === 'place'}
				title="Place mode"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="8" cy="8" r="2.2" />
					<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" stroke-width="1.2" fill="none" />
				</svg>
			</button>
			<button
				class={['chip icon-chip', { active: app.designMode === 'shuffle' }]}
				onclick={() => app.designMode !== 'shuffle' && app.toggleDesignMode()}
				aria-pressed={app.designMode === 'shuffle'}
				title="Shuffle mode"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M3 5.5h7.5M10.5 3.5L12.5 5.5 10.5 7.5M13 10.5H5.5M5.5 8.5L3.5 10.5 5.5 12.5"
						stroke="currentColor"
						stroke-width="1.3"
						fill="none"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</div>
	</div>

	<div class="group">
		<span class="label">Layout</span>
		<div class="row segmented">
			<button class="chip" onclick={() => app.cycleAspect()} title="Cycle aspect ratio">
				{app.aspect}
			</button>
			<button class="chip icon-chip" onclick={() => app.toggleMode()} title={app.mode === 'cluster' ? 'Cluster' : 'Stack'}>
				{#if app.mode === 'cluster'}
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="5" cy="6" r="2.4" />
						<circle cx="11.2" cy="4.8" r="2.4" />
						<circle cx="8.4" cy="11.2" r="2.4" />
					</svg>
				{:else}
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="2.8" r="2.4" />
						<circle cx="8" cy="8" r="2.4" />
						<circle cx="8" cy="13.2" r="2.4" />
					</svg>
				{/if}
			</button>
		</div>
	</div>

	<div class="group">
		<div class="row wrap">
			{#each ROCK_SVGS as _svg, i (i)}
				{@const shapeOn =
					app.designMode === 'place' ? app.rockIndex === i : app.shapeEnabled[i]}
				<button
					class={['shape', { on: shapeOn }]}
					onclick={() =>
						app.designMode === 'place' ? app.selectRock(i) : app.toggleShape(i)}
					title="Shape {i + 1}"
					aria-label="Shape {i + 1}"
					aria-pressed={shapeOn}
				>
					<img src={ROCK_IMAGE_URLS[i]} alt="" />
				</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<div class="color-grid">
			{#each ROCK_COLORS as color, i (color.hex)}
				{@const colorOn =
					app.designMode === 'place' ? app.colorIndex === i : app.colorEnabled[i]}
				<button
					class={['dot dot-button', { on: colorOn }]}
					style:background={color.hex}
					onclick={() =>
						app.designMode === 'place' ? app.selectColor(i) : app.toggleColor(i)}
					title={color.name}
					aria-label={color.name}
					aria-pressed={colorOn}
				></button>
			{/each}
		</div>
	</div>

	<div class="group">
		<div class="row segmented">
			{#each ROCK_SIZES as size, i (size.label)}
				<button
					class={['chip size-chip', { active: app.sizeIndex === i }]}
					onclick={() => app.selectSize(i)}
					title="Size {size.label}"
					aria-pressed={app.sizeIndex === i}
				>
					{size.label}
				</button>
			{/each}
		</div>
	</div>

	<div class="group image-tray">
		<span class="label">Images</span>
		<input
			{@attach (node) => void (fileInput = node)}
			type="file"
			accept="image/*"
			multiple
			onchange={onImagePicked}
			hidden
		/>
		<div class="thumbs">
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
							<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" />
						</svg>
					</button>
				</div>
			{/each}
			<button class="thumb add" onclick={() => fileInput?.click()} title="Upload images" aria-label="Upload images">
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
				</svg>
			</button>
		</div>
	</div>

	<div class="history-actions">
		<button
			class="history-btn"
			onclick={() => app.undo()}
			disabled={app.designMode !== 'place' || !app.canUndo}
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
			class="history-btn"
			onclick={() => app.redo()}
			disabled={app.designMode !== 'place' || !app.canRedo}
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
	</div>

	<div class="actions">
		{#if app.designMode === 'shuffle'}
			<button class="action-icon" onclick={() => app.shuffle()} title="Shuffle" aria-label="Shuffle">
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M3 5.5h7.5M10.5 3.5L12.5 5.5 10.5 7.5M13 10.5H5.5M5.5 8.5L3.5 10.5 5.5 12.5"
						stroke="currentColor"
						stroke-width="1.3"
						fill="none"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		{/if}
		<button class="action-icon" onclick={() => app.exportPng()} title="Download" aria-label="Download">
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

	<button class="clear" onclick={() => app.clear()} title="Clear the artboard">Clear</button>
</aside>

<style>
	.toolbar {
		flex: 0 0 auto;
		width: 200px;
		height: 100%;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 10px;
		padding: 12px;
		background: var(--paper);
		border-right: 1px solid var(--border);
		overflow-y: auto;
	}

	.brand {
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.01em;
		color: var(--ink);
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.label {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink);
		opacity: 0.5;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.row.wrap {
		flex-wrap: wrap;
		gap: 4px;
	}

	.color-grid {
		display: grid;
		grid-template-columns: repeat(5, 24px);
		gap: 8px;
		justify-content: start;
	}

	.row.segmented {
		gap: 0;
		border: 1px solid var(--border);
		border-radius: 4px;
		overflow: hidden;
	}

	.chip {
		font: inherit;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 0 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink);
		background: var(--paper);
		border: 1px solid var(--border);
		cursor: pointer;
		transition:
			border-color 100ms ease,
			background-color 100ms ease,
			color 100ms ease,
			opacity 100ms ease;
	}

	.row.segmented .chip {
		flex: 1;
		min-width: 0;
		height: 26px;
		padding: 0 4px;
		border-radius: 0;
		border: none;
		border-right: 1px solid var(--border);
	}

	.row.segmented .chip.icon-chip {
		padding: 0;
	}

	.row.segmented .chip:last-child {
		border-right: none;
	}

	.row.segmented .chip:hover {
		background: color-mix(in srgb, var(--ink) 4%, transparent);
	}

	.icon-chip svg {
		width: 13px;
		height: 13px;
		fill: currentColor;
		flex: 0 0 auto;
	}

	.chip.active {
		color: var(--paper);
		background: var(--ink);
		border-color: var(--ink);
	}

	.row.segmented .chip.active {
		border-color: transparent;
	}

	.size-chip {
		flex: 1;
		padding: 0;
	}

	.chip:hover {
		border-color: var(--ink);
	}

	.dot {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.dot-button {
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		cursor: pointer;
		opacity: 0.35;
		transition: opacity 100ms ease, box-shadow 100ms ease;
	}

	.dot-button.on {
		opacity: 1;
		box-shadow: 0 0 0 1px var(--paper), 0 0 0 2px var(--ink);
	}

	.shape {
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3px;
		background: none;
		border: none;
		cursor: pointer;
		opacity: 0.25;
		transition: opacity 100ms ease;
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

	.thumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.thumb-wrap {
		position: relative;
		padding-top: 4px;
		padding-right: 4px;
		padding-bottom: 4px;
		padding-left: 4px;
		margin-top: -4px;
		margin-right: -4px;
		margin-bottom: -4px;
		margin-left: -4px;
	}

	.thumb-wrap.editing .thumb {
		box-shadow: 0 0 0 1px var(--paper), 0 0 0 2px var(--ink);
		border-color: var(--ink);
	}

	.thumb-edit {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font: inherit;
		font-size: 9px;
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

	.thumb-edit:hover {
		background: rgba(16, 26, 49, 0.72);
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
		position: relative;
		width: 36px;
		height: 36px;
		padding: 0;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: var(--paper);
		overflow: hidden;
		transition: box-shadow 100ms ease, border-color 100ms ease;
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
	}

	.thumb.add svg {
		width: 14px;
		height: 14px;
	}

	.thumb.add:hover {
		opacity: 1;
		border-color: var(--ink);
	}

	.history-actions {
		display: flex;
		gap: 4px;
	}

	.history-btn {
		flex: 1;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		background: var(--paper);
		color: var(--ink);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
		transition: border-color 100ms ease, opacity 100ms ease;
	}

	.history-btn svg {
		width: 15px;
		height: 15px;
	}

	.history-btn:hover:not(:disabled) {
		border-color: var(--ink);
	}

	.history-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.actions {
		margin-top: auto;
		display: flex;
		gap: 4px;
	}

	.action-icon {
		flex: 1;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--ink);
		color: var(--paper);
		border: 1px solid var(--ink);
		border-radius: 4px;
		cursor: pointer;
		transition: opacity 100ms ease;
	}

	.action-icon svg {
		width: 16px;
		height: 16px;
	}

	.action-icon:hover {
		opacity: 0.88;
	}

	.clear {
		font: inherit;
		height: 28px;
		font-size: 11px;
		font-weight: 600;
		color: #ed4e3d;
		background: none;
		border: 1px solid color-mix(in srgb, #ed4e3d 35%, transparent);
		border-radius: 4px;
		cursor: pointer;
		transition: background-color 100ms ease, border-color 100ms ease;
	}

	.clear:hover {
		background: color-mix(in srgb, #ed4e3d 8%, transparent);
		border-color: #ed4e3d;
	}

	@media (max-width: 760px) {
		.toolbar {
			width: 180px;
			padding: 10px;
		}
	}
</style>
