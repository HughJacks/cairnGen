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
		<div class="row">
			<button
				class={['chip icon-chip', { active: app.designMode === 'place' }]}
				onclick={() => app.designMode !== 'place' && app.toggleDesignMode()}
				aria-pressed={app.designMode === 'place'}
				title="Switch to place mode"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="8" cy="8" r="2.2" />
					<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" stroke-width="1.2" fill="none" />
				</svg>
				<span>Place</span>
			</button>
			<button
				class={['chip icon-chip', { active: app.designMode === 'shuffle' }]}
				onclick={() => app.designMode !== 'shuffle' && app.toggleDesignMode()}
				aria-pressed={app.designMode === 'shuffle'}
				title="Switch to shuffle mode"
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
				<span>Shuffle</span>
			</button>
		</div>
	</div>

	<div class="group">
		<span class="label">Layout</span>
		<div class="row">
			<button class="chip" onclick={() => app.cycleAspect()} title="Cycle aspect ratio">
				Aspect {app.aspect}
			</button>
			<button class="chip icon-chip" onclick={() => app.toggleMode()} title="Toggle cluster or stack">
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
				<span>{app.mode === 'cluster' ? 'Cluster' : 'Stack'}</span>
			</button>
		</div>
	</div>

	{#if app.designMode === 'place'}
		<div class="group">
			<div class="rock-picker">
				<button class="arrow" onclick={() => app.cycleRock(-1)} title="Previous rock" aria-label="Previous rock">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				</button>
				<button class="rock-shape" onclick={() => app.cycleRock(1)} title="Cycle rock shape" aria-label="Cycle rock shape">
					<span style:transform="rotate({app.rotation}deg)">
						<img src={ROCK_IMAGE_URLS[app.rockIndex]} alt="" />
					</span>
				</button>
				<button class="arrow" onclick={() => app.cycleRock(1)} title="Next rock" aria-label="Next rock">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				</button>
			</div>
		</div>

		<div class="group">
			<div class="row wrap">
				{#each ROCK_COLORS as color, i (color.hex)}
					<button
						class={['dot dot-button', { on: app.colorIndex === i }]}
						style:background={color.hex}
						onclick={() => app.selectColor(i)}
						title={color.name}
						aria-label={color.name}
						aria-pressed={app.colorIndex === i}
					></button>
				{/each}
			</div>
		</div>

		<div class="group">
			<div class="row">
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
	{:else}
		<div class="group">
			<span class="label">Colors</span>
			<div class="row wrap">
				{#each ROCK_COLORS as color, i (color.hex)}
					<button
						class={['dot dot-button', { on: app.colorEnabled[i] }]}
						style:background={color.hex}
						onclick={() => app.toggleColor(i)}
						title="{color.name} {app.colorEnabled[i] ? 'on' : 'off'}"
						aria-pressed={app.colorEnabled[i]}
						aria-label={color.name}
					></button>
				{/each}
			</div>
		</div>

		<div class="group">
			<span class="label">Shapes</span>
			<div class="row wrap">
				{#each ROCK_SVGS as _svg, i (i)}
					<button
						class={['shape', { on: app.shapeEnabled[i] }]}
						onclick={() => app.toggleShape(i)}
						title="Shape {i + 1} {app.shapeEnabled[i] ? 'on' : 'off'}"
						aria-pressed={app.shapeEnabled[i]}
					>
						<img src={ROCK_IMAGE_URLS[i]} alt="" />
					</button>
				{/each}
			</div>
		</div>

		<div class="group">
			<span class="label">Sizes</span>
			<div class="row wrap">
				{#each ROCK_SIZES as size, i (size.label)}
					<button
						class={['chip size-chip', { active: app.sizeEnabled[i] }]}
						onclick={() => app.toggleSize(i)}
						title="Size {size.label} {app.sizeEnabled[i] ? 'on' : 'off'}"
						aria-pressed={app.sizeEnabled[i]}
					>
						{size.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}

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
				<button
					class={['thumb', { active: app.activeImageId === img.id, bg: app.backgroundImageId === img.id }]}
					onclick={() => app.selectImage(img.id)}
					title="Select image"
					aria-pressed={app.activeImageId === img.id}
				>
					<img src={img.src} alt="" />
					{#if app.backgroundImageId === img.id}
						<span class="thumb-badge">All</span>
					{/if}
				</button>
			{/each}
			<button class="thumb add" onclick={() => fileInput?.click()} title="Upload images" aria-label="Upload images">
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
				</svg>
			</button>
		</div>
		{#if app.activeImageId}
			<div class="row">
				<button
					class={['chip mini', { active: app.backgroundImageId === app.activeImageId }]}
					onclick={() => app.activeImageId && app.toggleBackground(app.activeImageId)}
					title="Fill every shape with this image"
				>
					Behind all
				</button>
				<button
					class="chip mini remove-chip"
					onclick={() => app.activeImageId && app.removeImage(app.activeImageId)}
					title="Remove image"
				>
					Remove
				</button>
			</div>
			<span class="mask-caption">
				{app.backgroundImageId === app.activeImageId
					? 'Fills every shape'
					: 'Click a shape to attach'}
			</span>
		{/if}
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
		<button class="action-icon" onclick={() => app.exportPng()} title="Export PNG" aria-label="Export PNG">
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
		width: 260px;
		height: 100%;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 18px;
		padding: 20px 18px;
		background: var(--paper);
		border-right: 1px solid var(--border);
		box-shadow: 2px 0 24px rgba(16, 26, 49, 0.08);
		overflow-y: auto;
	}

	.brand {
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 0.01em;
		color: var(--ink);
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink);
		opacity: 0.54;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.row.wrap {
		flex-wrap: wrap;
	}

	.chip {
		font: inherit;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 0 14px;
		border-radius: 999px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		background: var(--paper);
		border: 1px solid var(--border);
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background-color 120ms ease,
			color 120ms ease,
			opacity 120ms ease,
			transform 120ms ease;
	}

	.icon-chip svg {
		width: 16px;
		height: 16px;
		fill: currentColor;
		flex: 0 0 auto;
	}

	.chip.active {
		color: var(--paper);
		background: var(--ink);
		border-color: var(--ink);
	}

	.size-chip {
		flex: 1;
		padding: 0;
	}

	.rock-picker {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.arrow {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		padding: 0;
		background: none;
		border: none;
		color: var(--ink);
		cursor: pointer;
		opacity: 0.7;
		flex: 0 0 auto;
		transition: opacity 120ms ease, transform 120ms ease;
	}

	.arrow svg {
		width: 18px;
		height: 18px;
	}

	.arrow:hover {
		opacity: 1;
		transform: translateY(-1px);
	}

	.rock-shape {
		flex: 1;
		min-width: 0;
		height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px;
		background: none;
		border: none;
		cursor: pointer;
		transition: transform 120ms ease;
	}

	.rock-shape span {
		display: flex;
		align-items: center;
		justify-content: center;
		max-width: 100%;
		max-height: 100%;
	}

	.rock-shape img {
		max-width: 100%;
		max-height: 40px;
		width: auto;
		height: auto;
	}

	.rock-shape:hover {
		transform: translateY(-1px);
	}

	.chip:hover {
		transform: translateY(-1px);
		border-color: var(--ink);
	}

	.dot {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.dot-button {
		width: 26px;
		height: 26px;
		padding: 0;
		border: none;
		cursor: pointer;
		opacity: 0.4;
		transition: opacity 120ms ease, transform 120ms ease, box-shadow 120ms ease;
	}

	.dot-button.on {
		opacity: 1;
		box-shadow: 0 0 0 2px var(--paper), 0 0 0 3px var(--ink);
	}

	.dot-button:hover {
		transform: translateY(-1px);
	}

	.shape {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
		background: none;
		border: none;
		cursor: pointer;
		opacity: 0.25;
		transition: opacity 120ms ease, transform 120ms ease;
	}

	.shape.on {
		opacity: 1;
	}

	.shape:hover {
		transform: translateY(-1px);
	}

	.shape img {
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
	}

	.image-tray {
		margin-top: auto;
	}

	.thumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.thumb {
		position: relative;
		width: 44px;
		height: 44px;
		padding: 0;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--paper);
		overflow: hidden;
		cursor: pointer;
		transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.thumb:hover {
		transform: translateY(-1px);
	}

	.thumb.active {
		box-shadow: 0 0 0 2px var(--paper), 0 0 0 3px var(--ink);
		border-color: var(--ink);
	}

	.thumb.bg {
		border-color: var(--ink);
	}

	.thumb-badge {
		position: absolute;
		bottom: 2px;
		right: 2px;
		font-size: 8px;
		font-weight: 700;
		line-height: 1;
		padding: 2px 3px;
		border-radius: 4px;
		color: var(--paper);
		background: var(--ink);
	}

	.thumb.add {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--ink);
		border-style: dashed;
		opacity: 0.7;
	}

	.thumb.add svg {
		width: 16px;
		height: 16px;
	}

	.thumb.add:hover {
		opacity: 1;
		border-color: var(--ink);
	}

	.chip.mini {
		flex: 1;
		height: 32px;
		font-size: 12px;
		padding: 0 10px;
	}

	.mask-caption {
		font-size: 11px;
		font-weight: 600;
		text-align: center;
		color: var(--ink);
		opacity: 0.6;
	}

	.remove-chip {
		color: #ed4e3d;
		border-color: color-mix(in srgb, #ed4e3d 40%, transparent);
	}

	.remove-chip:hover {
		border-color: #ed4e3d;
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.action-icon {
		flex: 1;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--ink);
		color: var(--paper);
		border: 1px solid var(--ink);
		border-radius: 12px;
		cursor: pointer;
		transition: transform 120ms ease, opacity 120ms ease;
	}

	.action-icon svg {
		width: 20px;
		height: 20px;
	}

	.action-icon:hover {
		transform: translateY(-1px);
		opacity: 0.92;
	}

	.clear {
		font: inherit;
		height: 40px;
		font-size: 13px;
		font-weight: 600;
		color: #ED4E3D;
		background: none;
		border: 1px solid color-mix(in srgb, #ED4E3D 40%, transparent);
		border-radius: 12px;
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease;
	}

	.clear:hover {
		background: color-mix(in srgb, #ED4E3D 10%, transparent);
		border-color: #ED4E3D;
	}

	@media (max-width: 760px) {
		.toolbar {
			width: 220px;
			padding: 16px 14px;
		}
	}
</style>
