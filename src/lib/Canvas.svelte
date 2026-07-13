<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import paper from 'paper';
	import {
		app,
		ASPECTS,
		COLOR_PALETTES,
		hexEq,
		isPaperHex,
		isRockColorExcluded,
		PALETTE,
		rockColorIndex,
		ROCK_SIZES,
		type BgSwatch,
		type ColorPalette,
		type ColorPaletteId
	} from './state.svelte';
	import { ROCK_SVGS } from './rocks';
	import {
		settleContactsForExport,
		outlineDistance,
		invalidateSamples,
		GROUP_EPS
	} from './snapping';
	import {
		createWorld,
		destroyWorld,
		syncBody,
		removeBody,
		clearBodies,
		resetBodies,
		rebuildFromPath,
		beginDrag,
		endDrag,
		moveKinematic,
		rotateKinematic,
		pathOverlapsAny,
		setPathTranslateHook,
		debugPhysicsSnapshot
	} from './physics';
	import { generateShuffle } from './shuffle';

	/** Height (in canvas px) of the tallest rock; all rocks share the same scale factor. */
	const ROCK_HEIGHT = 140;
	const STAGE_PADDING = 28;
	/** Space above the canvas for the centered bg swatch bar + gap. */
	const BG_BAR_SPACE = 48;
	/** Max image zoom as a multiple of the cover scale that fills a mask. */
	const MAX_ZOOM = 4;
	const BG_DRAG_THRESHOLD = 2;
	const PAPER_HEX = '#FFFFFF';
	const INK_HEX = '#101A31';

	let stageW = $state(0);
	let stageH = $state(0);
	let ready = $state(false);
	let canvasEl: HTMLCanvasElement | null = null;
	let seenClearVersion = app.clearVersion;
	let seenExportVersion = app.exportVersion;
	let seenUndoVersion = app.undoVersion;
	let seenRedoVersion = app.redoVersion;
	let seenShuffleSeed = app.shuffleSeed;
	let seenCanvasBgVersion = app.canvasBgVersion;
	let seenColorShuffleVersion = app.colorShuffleVersion;
	let seenPaletteSwitchVersion = app.paletteSwitchVersion;
	let imageEditBaseline: CanvasSnapshot | null = null;
	let bgDiceSvg: SVGSVGElement | undefined = $state();
	let bgColorsEl: HTMLDivElement | null = $state(null);
	let bgDragIndex: number | null = $state(null);
	let bgDragMoved = false;
	let bgDragStartX = 0;
	let bgDragStartY = 0;
	let bgDragPointerId: number | null = null;
	/** Fixed slot-center X positions from pointerdown. Not spliced on reorder —
	 *  absolute mids must stay sorted for hit-testing (splicing caused an infinite loop). */
	let bgSlotMids: number[] = [];
	let bgDragRaf = 0;
	let bgDragPendingX: number | null = null;

	function bgSwatchTitle(hex: string | null): string {
		if (hex === null) return 'Transparent';
		if (isPaperHex(hex)) return 'Paper (background only)';
		return PALETTE.find((p) => hexEq(p.hex, hex))?.name ?? hex;
	}

	function isPaperSwatch(swatch: { hex: string | null }): boolean {
		return isPaperHex(swatch.hex);
	}

	/** Paper is bg-only: click moves it to front; no rock-pool toggle. */
	function onPaperSwatchActivate(index: number) {
		if (index <= 0) return;
		app.moveBgSwatchToFront(index);
		syncRocksFromColorSlots();
		commitHistory();
	}

	function toggleBgSwatchAndRemap(index: number) {
		const swatch = app.bgSwatches[index];
		if (swatch && isPaperSwatch(swatch)) {
			onPaperSwatchActivate(index);
			return;
		}
		const activating = swatch ? !swatch.enabled : false;
		const disabledHex = swatch?.enabled ? swatch.hex : null;
		if (!app.toggleBgSwatch(index)) return;
		if (
			syncRockSlotsAfterPaletteMutation({
				disabledHex,
				forceRemap: activating
			})
		)
			commitHistory();
	}

	function rollBgColors() {
		bgDiceSvg?.getAnimations().forEach((a) => a.cancel());
		bgDiceSvg?.animate(
			[
				{ transform: 'rotate(0deg) scale(1)' },
				{ transform: 'rotate(180deg) scale(1.25)' },
				{ transform: 'rotate(360deg) scale(1)' }
			],
			{ duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
		);
		app.shuffleRockColors();
	}

	/** Palette slot index for a fill hex (falls back to first usable non-bg slot). */
	function colorSlotForHex(hex: string): number {
		const exact = app.bgSwatches.findIndex((s) => s.hex !== null && hexEq(s.hex, hex));
		if (exact >= 0) return exact;
		for (let i = 0; i < app.bgSwatches.length; i++) {
			const s = app.bgSwatches[i];
			if (s?.enabled && s.hex && !isRockColorExcluded(s.hex, app.canvasBg)) return i;
		}
		return Math.min(1, Math.max(0, app.bgSwatches.length - 1));
	}

	function resolveFillSlot(slot: number): { slot: number; hex: string } | null {
		const trySlot = (i: number) => {
			const s = app.bgSwatches[i];
			if (!s?.enabled || s.hex === null) return null;
			if (isRockColorExcluded(s.hex, app.canvasBg)) return null;
			return { slot: i, hex: s.hex };
		};
		const direct = trySlot(slot);
		if (direct) return direct;
		for (let i = 0; i < app.bgSwatches.length; i++) {
			const resolved = trySlot(i);
			if (resolved) return resolved;
		}
		return null;
	}

	function writeRockMeta(
		path: paper.Path,
		patch: Partial<RockMeta> & Pick<RockMeta, 'rockIndex' | 'sizeIndex' | 'rotation'>
	) {
		const prev = rockMeta.get(path);
		rockMeta.set(path, {
			rockIndex: patch.rockIndex,
			sizeIndex: patch.sizeIndex,
			rotation: patch.rotation,
			colorSlot: patch.colorSlot ?? prev?.colorSlot ?? colorSlotForHex(app.nextColor.hex),
			locked: patch.locked ?? prev?.locked
		});
	}

	/** Apply each rock's colorSlot → current palette swatch (skips locked / masked). */
	function syncRocksFromColorSlots(): boolean {
		let changed = false;
		for (const path of placed) {
			if (isLocked(path)) continue;
			if (attach.has(path)) continue;
			if (app.backgroundImageId && !solidOnly.has(path)) continue;
			const meta = rockMeta.get(path);
			let slot = meta?.colorSlot;
			if (slot === undefined || slot < 0) {
				const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
				slot = cur ? colorSlotForHex(cur) : colorSlotForHex(app.nextColor.hex);
			}
			const resolved = resolveFillSlot(slot);
			if (!resolved) continue;
			if (!meta || meta.colorSlot !== resolved.slot) {
				writeRockMeta(path, {
					rockIndex: meta?.rockIndex ?? 0,
					sizeIndex: meta?.sizeIndex ?? app.sizeIndex,
					rotation: meta?.rotation ?? path.rotation,
					colorSlot: resolved.slot,
					locked: meta?.locked
				});
			}
			const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
			if (!cur || !hexEq(cur, resolved.hex)) {
				path.fillColor = new paper.Color(resolved.hex);
				changed = true;
			}
		}
		if (changed) {
			if (selectedPaths.length) syncSelectionUi(selectedPaths.at(-1) ?? null);
			updateGhost();
		}
		return changed;
	}

	/**
	 * After enable/disable (+ partition): remap unlocked rocks onto the enabled
	 * fill pool. When `disabledHex` is set and `forceRemap` is false, rocks whose
	 * color is still valid keep it (slot index refreshed); only rocks on the
	 * disabled color are reassigned. When `forceRemap` is true (activate), every
	 * unlocked rock is redistributed across the pool so the new color is used.
	 */
	function syncRockSlotsAfterPaletteMutation(opts?: {
		disabledHex?: string | null;
		forceRemap?: boolean;
	}): boolean {
		const pool = app.enabledBgRockColors;
		if (!pool.length) return false;
		const disabledHex = opts?.disabledHex ?? null;
		const forceRemap = opts?.forceRemap ?? false;
		let changed = false;
		let poolCursor = 0;
		for (const path of placed) {
			if (isLocked(path)) continue;
			if (attach.has(path)) continue;
			if (app.backgroundImageId && !solidOnly.has(path)) continue;

			const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
			const meta = rockMeta.get(path);
			const curStillValid =
				!forceRemap &&
				!!cur &&
				!(disabledHex && hexEq(cur, disabledHex)) &&
				pool.some((h) => hexEq(h, cur));

			let hex: string;
			if (curStillValid) {
				hex = cur!;
			} else {
				hex = pool[poolCursor % pool.length]!;
				poolCursor++;
			}

			const slot = colorSlotForHex(hex);
			if (!meta || meta.colorSlot !== slot) {
				writeRockMeta(path, {
					rockIndex: meta?.rockIndex ?? 0,
					sizeIndex: meta?.sizeIndex ?? app.sizeIndex,
					rotation: meta?.rotation ?? path.rotation,
					colorSlot: slot,
					locked: meta?.locked
				});
			}
			if (!cur || !hexEq(cur, hex)) {
				path.fillColor = new paper.Color(hex);
				changed = true;
			}
		}
		if (changed) {
			if (selectedPaths.length) syncSelectionUi(selectedPaths.at(-1) ?? null);
			updateGhost();
		}
		return changed;
	}

	/** Remap rocks whose fill is Paper/Ink (or otherwise outside the chromatic pool). */
	function coerceExcludedRockFills(): boolean {
		return syncRockSlotsAfterPaletteMutation({ forceRemap: false });
	}

	function cacheBgSlotMids() {
		if (!bgColorsEl) {
			bgSlotMids = [];
			return;
		}
		const slots = Array.from(bgColorsEl.querySelectorAll<HTMLElement>('.bg-slot'));
		bgSlotMids = slots.map((el) => {
			const rect = el.getBoundingClientRect();
			return rect.left + rect.width / 2;
		});
	}

	function bgTargetIndexFromClientX(clientX: number): number {
		if (bgDragIndex === null || !bgSlotMids.length) return bgDragIndex ?? 0;
		let target = 0;
		for (let i = 0; i < bgSlotMids.length; i++) {
			if (clientX < bgSlotMids[i]!) {
				target = i;
				break;
			}
			target = i;
		}
		return target;
	}

	function applyBgReorder(clientX: number) {
		if (bgDragIndex === null) return;
		let target = bgTargetIndexFromClientX(clientX);
		const dragged = app.bgSwatches[bgDragIndex];
		// Paper may only land at first (bg) or last (deactivated).
		if (dragged && isPaperSwatch(dragged)) {
			const last = app.bgSwatches.length - 1;
			target = Math.abs(target - 0) <= Math.abs(target - last) ? 0 : last;
		}
		if (target === bgDragIndex) return;
		const from = bgDragIndex;
		bgDragIndex = target;
		app.reorderBgSwatch(from, target, { deferBg: true });
		syncRocksFromColorSlots();
	}

	function onBgSlotPointerDown(e: PointerEvent, index: number) {
		if (e.button !== 0) return;
		e.preventDefault();
		bgDragIndex = index;
		bgDragMoved = false;
		bgDragStartX = e.clientX;
		bgDragStartY = e.clientY;
		bgDragPointerId = e.pointerId;
		bgDragPendingX = null;
		if (bgDragRaf) {
			cancelAnimationFrame(bgDragRaf);
			bgDragRaf = 0;
		}
		cacheBgSlotMids();
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* capture optional; window listeners are source of truth */
		}
	}

	function onBgDragMove(e: PointerEvent) {
		if (bgDragIndex === null) return;
		if (bgDragPointerId !== null && e.pointerId !== bgDragPointerId) return;
		const dx = e.clientX - bgDragStartX;
		const dy = e.clientY - bgDragStartY;
		if (!bgDragMoved && Math.hypot(dx, dy) < BG_DRAG_THRESHOLD) return;
		bgDragMoved = true;
		bgDragPendingX = e.clientX;
		if (bgDragRaf) return;
		bgDragRaf = requestAnimationFrame(() => {
			bgDragRaf = 0;
			const x = bgDragPendingX;
			bgDragPendingX = null;
			if (x === null || bgDragIndex === null) return;
			applyBgReorder(x);
		});
	}

	function onBgDragEnd(e: PointerEvent) {
		if (bgDragIndex === null) return;
		if (bgDragPointerId !== null && e.pointerId !== bgDragPointerId) return;
		if (bgDragRaf) {
			cancelAnimationFrame(bgDragRaf);
			bgDragRaf = 0;
			if (bgDragPendingX !== null && bgDragMoved) applyBgReorder(bgDragPendingX);
			bgDragPendingX = null;
		}
		const index = bgDragIndex;
		const wasDrag = bgDragMoved;
		bgDragIndex = null;
		bgDragMoved = false;
		bgDragPointerId = null;
		bgSlotMids = [];
		if (wasDrag) {
			app.finalizeBgSwatchOrder();
			syncRocksFromColorSlots();
			commitHistory();
		} else toggleBgSwatchAndRemap(index);
	}

	// Download dialog: pick format; optional transparent export when bg is white.
	let showExportDialog = $state(false);
	type ExportFormat = 'png' | 'svg';
	let exportFormat = $state<ExportFormat>('png');
	let exportTransparent = $state(false);
	let dialogEl = $state<HTMLDialogElement | null>(null);
	const canExportTransparent = $derived(
		typeof app.canvasBg === 'string' && hexEq(app.canvasBg, PAPER_HEX)
	);
	let leadingPaletteId = $state<ColorPaletteId>(app.activePaletteId);
	let expandedPaletteId = $state<ColorPaletteId>(app.activePaletteId);
	let paletteSwitching = false;
	const paletteStripEls: Partial<Record<ColorPaletteId, HTMLDivElement>> = {};
	/** Frozen swatch order for inactive palettes so condensed strips don't reshuffle. */
	let frozenSwatches: Partial<Record<ColorPaletteId, BgSwatch[]>> = {};

	const orderedPalettes = $derived([
		COLOR_PALETTES.find((p) => p.id === leadingPaletteId)!,
		...COLOR_PALETTES.filter((p) => p.id !== leadingPaletteId)
	]);

	const PALETTE_FLIP_MS = 420;
	const PALETTE_MORPH_MS = 380;
	const PALETTE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

	function sleep(ms: number) {
		return new Promise<void>((resolve) => setTimeout(resolve, ms));
	}

	/** Swatches shown in a palette strip — live bgSwatches when that palette is active.
	 *  Condensed fans hide Paper and Ink (chrome only). */
	function paletteDisplaySwatches(palette: ColorPalette, expanded: boolean): BgSwatch[] {
		const list =
			app.activePaletteId === palette.id
				? app.bgSwatches
				: (frozenSwatches[palette.id] ??
					palette.colors.map((c) => ({ key: c.hex, hex: c.hex, enabled: true })));
		if (expanded) return list;
		return list.filter(
			(s) =>
				s.hex !== null && !hexEq(s.hex, PAPER_HEX) && !hexEq(s.hex, INK_HEX)
		);
	}

	function trackPaletteStrip(id: ColorPaletteId) {
		return (node: HTMLDivElement) => {
			paletteStripEls[id] = node;
			if (expandedPaletteId === id) bgColorsEl = node;
			return () => {
				if (paletteStripEls[id] === node) delete paletteStripEls[id];
				if (bgColorsEl === node) bgColorsEl = null;
			};
		};
	}

	$effect(() => {
		const id = expandedPaletteId;
		bgColorsEl = paletteStripEls[id] ?? null;
	});

	async function onSelectPalette(id: ColorPaletteId) {
		if (paletteSwitching) return;
		if (id === app.activePaletteId && id === leadingPaletteId && expandedPaletteId === id) return;
		paletteSwitching = true;
		try {
			// 1. Reorder first — DOM order + flip (heights stay fixed)
			leadingPaletteId = id;
			await sleep(PALETTE_FLIP_MS);
			// 2. Contract old + expand new at the same time
			const prev = app.activePaletteId;
			frozenSwatches[prev] = app.bgSwatches.map((s) => ({ ...s }));
			app.selectPalette(id);
			expandedPaletteId = id;
			await sleep(PALETTE_MORPH_MS);
		} finally {
			leadingPaletteId = app.activePaletteId;
			expandedPaletteId = app.activePaletteId;
			paletteSwitching = false;
		}
	}

	function exportDialog(node: HTMLDialogElement) {
		dialogEl = node;
		return () => {
			dialogEl = null;
		};
	}

	let sourcePaths: paper.Path[] = [];
	let placed: paper.Path[] = [];
	let ghost: paper.Path | null = null;
	let pointer: paper.Point | null = null;

	// Union-find over `placed` indices, grouping rocks into touching stacks.
	let groupParent: number[] = [];

	// Canvas dimensions the current placed layout was sized for, so the whole
	// composition can be rescaled proportionally when the artboard changes.
	let placedArtboard = { w: 0, h: 0 };

	// --- Image fills -------------------------------------------------------
	// Uploaded photos replace a rock's solid fill. A photo can either be pinned
	// to one specific rock instance (its own pan/zoom), or be set as the single
	// "behind all" background: the un-pinned rocks are merged into one unified
	// silhouette that masks a single image sitting behind the whole cairn.
	interface PinFill {
		group: paper.Group;
		clip: paper.Path;
		raster: paper.Raster;
		imageId: string;
	}
	interface BgFillGroup {
		group: paper.Group;
		clip: paper.Path;
		raster: paper.Raster;
		path: paper.Path;
	}
	interface BgFill {
		groups: BgFillGroup[];
	}
	type Hit = { kind: 'pin'; fill: PinFill } | { kind: 'bg'; fill: BgFill };

	// Loaded source elements keyed by image id.
	let imageEls = new Map<string, HTMLImageElement>();
	// Per-instance pins: rock path -> image id.
	let attach = new Map<paper.Path, string>();
	// Live per-instance clipped groups keyed by rock path.
	let fills = new Map<paper.Path, PinFill>();
	// The single unified background group (union of un-pinned rocks + image).
	let bgFill: BgFill | null = null;
	// Shared transform for the background image.
	let bgId: string | null = null;
	let bgScale = 1;
	let bgCenter: paper.Point | null = null;
	// Bumped whenever an image source finishes loading, to re-run the sync.
	let imageLoadTick = $state(0);
	let imageDrag: { kind: 'pin' | 'bg'; fill: PinFill | BgFill; last: paper.Point } | null = null;
	let didDragImage = false;
	let shapeDrag: {
		paths: paper.Path[];
		grabOffset: paper.Point;
	} | null = null;
	let didDragShape = false;
	let draggingShape = $state(false);
	/** Custom cursor while a drag would cull the rock on release. */
	const TRASH_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
			<circle cx="16" cy="16" r="14" fill="#fff" fill-opacity="0.94" stroke="#101a31" stroke-width="1.2"/>
			<g fill="none" stroke="#101a31" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
				<path d="M11 12h10l-.85 11.2a1.6 1.6 0 0 1-1.6 1.45h-5.1a1.6 1.6 0 0 1-1.6-1.45L11 12z"/>
				<path d="M9.5 12h13M13.5 12V10.4A1.6 1.6 0 0 1 15.1 8.8h1.8a1.6 1.6 0 0 1 1.6 1.6V12M14.75 15.5v5M17.25 15.5v5"/>
			</g>
		</svg>`
	)}") 16 16, not-allowed`;

	function dragWouldDelete(paths: paper.Path[]): boolean {
		const bounds = viewBounds();
		return paths.some((p) => !rockVisibleOnArtboard(p, bounds));
	}

	function setShapeDragCursor(willDelete: boolean) {
		const cursor = willDelete ? TRASH_CURSOR : 'grabbing';
		if (canvasEl) canvasEl.style.cursor = cursor;
		document.body.style.cursor = cursor;
	}

	function clearShapeDragCursor() {
		if (canvasEl) canvasEl.style.cursor = '';
		document.body.style.cursor = '';
	}

	const MARQUEE_THRESHOLD = 4;
	let marqueeDrag: {
		start: paper.Point;
		additive: boolean;
		baseline: paper.Path[];
	} | null = null;
	let didDragMarquee = false;
	let marqueePath: paper.Path | null = null;
	let draggingMarquee = $state(false);
	let selectedPaths = $state.raw<paper.Path[]>([]);
	const selectedPath = $derived(selectedPaths.at(-1) ?? null);
	const multiSelected = $derived(selectedPaths.length > 1);
	let selectionOutlines: paper.Path[] = [];
	let ghostRaf = 0;
	let shiftHeld = $state(false);

	/** In-flight slam placement animations (cancelled on clear). */
	let slamGeneration = 0;
	const slamRafs = new Set<number>();
	const slamTimeouts = new Set<ReturnType<typeof setTimeout>>();
	/** While set, skip rebuilding the placement ghost so it doesn't cover the settle-in. */
	let ghostSuppressedUntil = 0;
	const ghostFadeRafs = new Set<number>();
	let ghostResumeTid: ReturnType<typeof setTimeout> | null = null;

	/** Per-rock shape/size metadata (pathData alone can't recover these). */
	interface RockMeta {
		rockIndex: number;
		sizeIndex: number;
		rotation: number;
		/** Index into `app.bgSwatches` — fill follows whatever color is in this slot. */
		colorSlot: number;
		locked?: boolean;
	}
	let rockMeta = new WeakMap<paper.Path, RockMeta>();
	/** Rocks that stay solid-colored even when a background image fill is active. */
	let solidOnly = new WeakSet<paper.Path>();

	let selectedRockIndex = $state(0);
	let selectedSizeIndex = $state(1);
	let selectedColorIndex = $state(0);
	let selectedLocked = $state(false);
	/** Image src shown in the tip when the selection is masked; null = show colors. */
	let selectedMaskSrc = $state<string | null>(null);
	let selectedMaskId = $state<string | null>(null);
	/** Unclipped translucent copy of the active mask image (edit / masked selection). */
	let editGhost: paper.Raster | null = null;
	let tipShake = $state(false);
	let tipShakeTimer: ReturnType<typeof setTimeout> | null = null;
	/** When true, reshape/fill sync won't move the tip to the rock's new center. */
	let tipLocked = false;
	let tipPos = $state<{ left: number; top: number } | null>(null);
	let tipAnchor = $state<{ x: number; y: number } | null>(null);
	let tipEl: HTMLElement | undefined;

	const ROCK_IMAGE_URLS = ROCK_SVGS.map(
		(svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
	);

	function placeTip() {
		if (!tipEl || !tipAnchor || !canvasEl) return;
		const pad = 8;
		const gap = 10;
		const { width: tw, height: th } = tipEl.getBoundingClientRect();
		if (tw < 1 || th < 1) return;
		const canvas = canvasEl.getBoundingClientRect();
		if (canvas.width < 1 || canvas.height < 1) return;

		const ax = tipAnchor.x;
		const ay = tipAnchor.y;
		// Single: bottom-left on the rock center. Multi: centered above the group.
		const baseLeft = selectedPaths.length > 1 ? ax - tw / 2 : ax;

		const minLeft = canvas.left + pad;
		const maxLeft = canvas.right - tw - pad;
		const minTop = canvas.top + pad;
		const maxTop = canvas.bottom - th - pad;

		const clampPos = (left: number, top: number) => ({
			left: maxLeft >= minLeft ? Math.min(Math.max(left, minLeft), maxLeft) : canvas.left + (canvas.width - tw) / 2,
			top: maxTop >= minTop ? Math.min(Math.max(top, minTop), maxTop) : canvas.top + (canvas.height - th) / 2
		});

		// Prefer above the rock; fall back below / beside — all clamped to the canvas.
		const candidates = [
			{ left: baseLeft, top: ay - th - gap },
			{ left: baseLeft, top: ay + gap },
			{ left: ax - tw - gap, top: ay - th / 2 },
			{ left: ax + gap, top: ay - th / 2 }
		];

		let best = clampPos(candidates[0]!.left, candidates[0]!.top);
		let bestDist = Infinity;
		for (const c of candidates) {
			const p = clampPos(c.left, c.top);
			const dist = Math.hypot(p.left - c.left, p.top - c.top);
			if (dist < bestDist - 1e-6) {
				best = p;
				bestDist = dist;
				if (dist < 1e-6) break;
			}
		}
		tipPos = best;
	}

	function clampTip(node: HTMLElement) {
		tipEl = node;
		placeTip();
		const ro = new ResizeObserver(() => placeTip());
		ro.observe(node);
		if (canvasEl) ro.observe(canvasEl);
		window.addEventListener('resize', placeTip);
		return () => {
			if (tipEl === node) tipEl = undefined;
			ro.disconnect();
			window.removeEventListener('resize', placeTip);
		};
	}

	// --- Undo / redo ---------------------------------------------------------
	interface PinTransform {
		imageId: string;
		scaleX: number;
		scaleY: number;
		x: number;
		y: number;
	}

	interface CanvasSnapshot {
		rocks: {
			pathData: string;
			fillColor: string;
			rockIndex: number;
			sizeIndex: number;
			rotation: number;
			colorSlot?: number;
			locked?: boolean;
		}[];
		attach: [number, string][];
		/** Indices of rocks that opt out of the background image fill. */
		solidOnly: number[];
		pins: [number, PinTransform][];
		backgroundImageId: string | null;
		bgScale: number;
		bgCenter: { x: number; y: number } | null;
		placedArtboard: { w: number; h: number };
	}

	let historyRecording = true;
	let historyStack: CanvasSnapshot[] = [];
	let historyIndex = -1;
	let rotateHistoryGesture = false;
	let rotateHistoryIdleTimer: ReturnType<typeof setTimeout> | null = null;
	const ROTATE_HISTORY_IDLE_MS = 400;

	function captureSnapshot(): CanvasSnapshot {
		return {
			rocks: placed.map((p) => {
				const meta = rockMeta.get(p);
				return {
					pathData: p.pathData,
					fillColor: (p.fillColor as paper.Color | null)?.toCSS(true) ?? app.nextColor.hex,
					rockIndex: meta?.rockIndex ?? 0,
					sizeIndex: meta?.sizeIndex ?? app.sizeIndex,
					rotation: meta?.rotation ?? p.rotation,
					colorSlot: meta?.colorSlot,
					locked: meta?.locked
				};
			}),
			attach: placed.flatMap((p, i) => {
				const id = attach.get(p);
				return id ? ([[i, id]] as [number, string][]) : [];
			}),
			solidOnly: placed.flatMap((p, i) => (solidOnly.has(p) ? [i] : [])),
			pins: placed.flatMap((p, i) => {
				const fill = fills.get(p);
				if (!fill) return [];
				return [
					[
						i,
						{
							imageId: fill.imageId,
							scaleX: fill.raster.scaling.x,
							scaleY: fill.raster.scaling.y,
							x: fill.raster.position.x,
							y: fill.raster.position.y
						}
					] as [number, PinTransform]
				];
			}),
			backgroundImageId: app.backgroundImageId,
			bgScale,
			bgCenter: bgCenter ? { x: bgCenter.x, y: bgCenter.y } : null,
			placedArtboard: { ...placedArtboard }
		};
	}

	function recomputeGroups() {
		groupParent = placed.map((_, i) => i);
		for (let i = 0; i < placed.length; i++) {
			for (let j = 0; j < i; j++) {
				if (!placed[j].bounds.expand(GROUP_EPS * 4).intersects(placed[i].bounds)) continue;
				if (outlineDistance(placed[i], placed[j]) <= GROUP_EPS) {
					groupParent[findGroup(j)] = findGroup(i);
				}
			}
		}
	}

	function restoreSnapshot(snap: CanvasSnapshot) {
		cancelSlamAnimations();
		clearFills();
		clearBodies();
		for (const p of placed) p.remove();
		placed = [];
		groupParent = [];
		attach.clear();
		solidOnly = new WeakSet();
		rockMeta = new WeakMap();

		for (const rock of snap.rocks) {
			const path = new paper.Path({ insert: false });
			path.pathData = rock.pathData;
			path.fillColor = new paper.Color(rock.fillColor);
			paper.project.activeLayer.addChild(path);
			placed.push(path);
			syncBody(path);
			rockMeta.set(path, {
				rockIndex: rock.rockIndex ?? 0,
				sizeIndex: rock.sizeIndex ?? app.sizeIndex,
				rotation: rock.rotation ?? 0,
				colorSlot:
					rock.colorSlot ??
					colorSlotForHex(rock.fillColor ?? app.nextColor.hex),
				locked: rock.locked
			});
		}

		recomputeGroups();
		placedArtboard = { ...snap.placedArtboard };

		for (const [i, imageId] of snap.attach) {
			const path = placed[i];
			if (path) attach.set(path, imageId);
		}
		for (const i of snap.solidOnly ?? []) {
			const path = placed[i];
			if (path) solidOnly.add(path);
		}

		app.backgroundImageId = snap.backgroundImageId;
		bgScale = snap.bgScale;
		bgCenter = snap.bgCenter ? new paper.Point(snap.bgCenter.x, snap.bgCenter.y) : null;
		bgId = snap.backgroundImageId;

		syncFills();

		for (const [i, pin] of snap.pins) {
			const path = placed[i];
			const fill = path ? fills.get(path) : undefined;
			if (!fill || fill.imageId !== pin.imageId) continue;
			fill.raster.scaling = new paper.Point(pin.scaleX, pin.scaleY);
			fill.raster.position = new paper.Point(pin.x, pin.y);
		}

		if (bgFill) reapplyBg();
		app.placedCount = placed.length;
		coerceExcludedRockFills();
		cullOffCanvasPlaced();
		selectShape(null);
		updateGhost();
	}

	function syncHistoryFlags() {
		app.setUndoRedo(historyIndex > 0, historyIndex < historyStack.length - 1);
	}

	function initHistory() {
		historyStack = [captureSnapshot()];
		historyIndex = 0;
		syncHistoryFlags();
	}

	function endRotateHistoryGesture() {
		const wasRotating = rotateHistoryGesture;
		rotateHistoryGesture = false;
		if (rotateHistoryIdleTimer) {
			clearTimeout(rotateHistoryIdleTimer);
			rotateHistoryIdleTimer = null;
		}
		// Wheel rotation defers full fill rebuild until the gesture ends.
		if (wasRotating) finalizeShapeTransform();
	}

	function commitRotateHistory() {
		if (!historyRecording || !ready) return;
		const snap = captureSnapshot();
		if (rotateHistoryGesture && historyIndex >= 0) {
			historyStack[historyIndex] = snap;
		} else {
			historyStack = historyStack.slice(0, historyIndex + 1);
			historyStack.push(snap);
			historyIndex++;
			rotateHistoryGesture = true;
		}
		syncHistoryFlags();
		if (rotateHistoryIdleTimer) clearTimeout(rotateHistoryIdleTimer);
		rotateHistoryIdleTimer = setTimeout(endRotateHistoryGesture, ROTATE_HISTORY_IDLE_MS);
	}

	function commitHistory() {
		endRotateHistoryGesture();
		if (!historyRecording || !ready) return;
		const snap = captureSnapshot();
		historyStack = historyStack.slice(0, historyIndex + 1);
		historyStack.push(snap);
		historyIndex++;
		syncHistoryFlags();
	}

	function undoHistory() {
		endRotateHistoryGesture();
		if (historyIndex <= 0) return;
		historyIndex--;
		historyRecording = false;
		restoreSnapshot(historyStack[historyIndex]);
		historyRecording = true;
		syncHistoryFlags();
	}

	function redoHistory() {
		endRotateHistoryGesture();
		if (historyIndex >= historyStack.length - 1) return;
		historyIndex++;
		historyRecording = false;
		restoreSnapshot(historyStack[historyIndex]);
		historyRecording = true;
		syncHistoryFlags();
	}

	function loadImage(id: string, src: string) {
		const img = new Image();
		img.onload = () => {
			imageEls.set(id, img);
			imageLoadTick++;
		};
		img.src = src;
	}

	/** Grow/shift a raster until it fully covers a rectangle, so a rock's edges
	 *  and the image's corners are never exposed. Only the portion of the mask
	 *  inside the canvas frame must stay covered — anything off-frame is never
	 *  visible, so image edges are allowed to fall there. */
	function coverClamp(raster: paper.Raster, cb: paper.Rectangle) {
		const eff = cb.intersect(viewBounds());
		if (eff.width <= 0 || eff.height <= 0) return;
		const grow = Math.max(eff.width / raster.bounds.width, eff.height / raster.bounds.height, 1);
		if (grow > 1) raster.scale(grow);
		const b = raster.bounds;
		let dx = 0;
		let dy = 0;
		if (b.left > eff.left) dx = eff.left - b.left;
		else if (b.right < eff.right) dx = eff.right - b.right;
		if (b.top > eff.top) dy = eff.top - b.top;
		else if (b.bottom < eff.bottom) dy = eff.bottom - b.bottom;
		if (dx !== 0 || dy !== 0) raster.position = raster.position.add(new paper.Point(dx, dy));
	}

	function clamp(v: number, lo: number, hi: number): number {
		if (lo > hi) return (lo + hi) / 2;
		return Math.min(Math.max(v, lo), hi);
	}

	function coverScale(el: HTMLImageElement, w: number, h: number): number {
		return Math.max(w / el.naturalWidth, h / el.naturalHeight);
	}

	function clampBgScale(scale: number, el: HTMLImageElement, rect: paper.Rectangle): number {
		if (rect.width <= 0 || rect.height <= 0) return scale;
		const min = coverScale(el, rect.width, rect.height);
		return clamp(scale, min, min * MAX_ZOOM);
	}

	function clampPinRaster(raster: paper.Raster, clip: paper.Path, el: HTMLImageElement) {
		const min = coverScale(el, clip.bounds.width, clip.bounds.height);
		const max = min * MAX_ZOOM;
		const sx = raster.scaling.x;
		const sy = raster.scaling.y;
		raster.scaling = new paper.Point(clamp(sx, min, max), clamp(sy, min, max));
	}

	/** Paper.js clipped groups often fail to paint until the raster has loaded. */
	function whenRasterReady(raster: paper.Raster, fn: () => void) {
		if (raster.loaded) fn();
		else raster.onLoad = fn;
	}

	/** Establish the background baseline (cover the whole view, centered) when
	 *  it isn't set yet or the background image changed. */
	function ensureBgInit() {
		const bg = app.backgroundImageId;
		if (!bg) {
			bgCenter = null;
			bgId = null;
			return;
		}
		const el = imageEls.get(bg);
		if (!el) return;
		if (!bgCenter || bgId !== bg) {
			bgId = bg;
			bgCenter = paper.view.center;
			bgScale = Math.max(
				paper.view.viewSize.width / el.naturalWidth,
				paper.view.viewSize.height / el.naturalHeight
			);
		}
	}

	/** Bounds of every rock in the unified background mask. */
	function bgClipBounds(): paper.Rectangle | null {
		if (!bgFill?.groups.length) return null;
		let bounds = bgFill.groups[0].clip.bounds;
		for (let i = 1; i < bgFill.groups.length; i++) {
			bounds = bounds.unite(bgFill.groups[i].clip.bounds);
		}
		return bounds;
	}

	function bgFillReady(): boolean {
		return !!bgFill && bgFill.groups.length > 0 && bgFill.groups.every((g) => g.raster.loaded);
	}

	/** Clamp the background transform so it still covers the unified silhouette,
	 *  then push it to every background raster (they share one pan/zoom). */
	function reapplyBg() {
		if (!bgFill || !bgCenter) return;
		const bg = app.backgroundImageId;
		const el = bg ? imageEls.get(bg) : undefined;
		if (!el) return;
		const clipBounds = bgClipBounds();
		if (!clipBounds) return;
		// Only keep the on-canvas part of the silhouette covered; the mask may
		// extend past the frame, and image edges hidden there are fine.
		const rect = clipBounds.intersect(viewBounds());
		if (rect.width > 0 && rect.height > 0) {
			bgScale = clampBgScale(bgScale, el, rect);
			const halfW = (el.naturalWidth * bgScale) / 2;
			const halfH = (el.naturalHeight * bgScale) / 2;
			bgCenter = new paper.Point(
				clamp(bgCenter.x, rect.right - halfW, rect.left + halfW),
				clamp(bgCenter.y, rect.bottom - halfH, rect.top + halfH)
			);
		}
		for (const { raster, clip } of bgFill.groups) {
			raster.scaling = new paper.Point(bgScale, bgScale);
			raster.position = bgCenter;
			coverClamp(raster, clip.bounds);
		}
		updateEditGhost();
	}

	function addPinFill(path: paper.Path, imageId: string) {
		const el = imageEls.get(imageId);
		if (!el) return;
		const clip = cloneRockGeometry(path);
		const raster = new paper.Raster(el);
		const cover = coverScale(el, path.bounds.width, path.bounds.height);
		raster.scaling = new paper.Point(cover, cover);
		raster.position = path.bounds.center;
		const group = new paper.Group([clip, raster]);
		group.clipped = true;
		paper.project.activeLayer.addChild(group);
		const fill: PinFill = { group, clip, raster, imageId };
		fills.set(path, fill);
		whenRasterReady(raster, () => {
			coverClamp(raster, clip.bounds);
			clampPinRaster(raster, clip, el);
			path.visible = false;
			updateEditGhost();
			paper.view.update();
		});
	}

	function removeFill(path: paper.Path) {
		const fill = fills.get(path);
		if (!fill) return;
		fill.group.remove();
		fills.delete(path);
		path.visible = true;
	}

	function removeBgFill() {
		if (!bgFill) return;
		for (const { group } of bgFill.groups) group.remove();
		bgFill = null;
	}

	function clearFills() {
		for (const path of [...fills.keys()]) removeFill(path);
		removeBgFill();
		clearEditGhost();
	}

	/** Clone a placed rock's geometry for masking. Hidden paths can produce
	 *  broken clones in Paper.js, so rebuild from pathData + matrix instead. */
	function cloneRockGeometry(p: paper.Path): paper.Path {
		const c = new paper.Path({ insert: false });
		c.pathData = p.pathData;
		c.matrix = p.matrix.clone();
		c.fillColor = null;
		c.strokeColor = null;
		c.visible = true;
		return c;
	}

	/** Cheap live update: sync existing fill clip geometry to match rotated
	 *  rocks without tearing down rasters / buildBgFill. */
	function syncFillClipsForPaths(paths: paper.Path[]) {
		let bgDirty = false;
		for (const path of paths) {
			const pin = fills.get(path);
			if (pin) {
				pin.clip.pathData = path.pathData;
				pin.clip.matrix = path.matrix.clone();
				coverClamp(pin.raster, pin.clip.bounds);
				const el = imageEls.get(pin.imageId);
				if (el) clampPinRaster(pin.raster, pin.clip, el);
			}
			const bg = bgFill?.groups.find((g) => g.path === path);
			if (bg) {
				bg.clip.pathData = path.pathData;
				bg.clip.matrix = path.matrix.clone();
				bgDirty = true;
			}
		}
		if (bgDirty) reapplyBg();
	}

	/** Clip the same background image to each un-pinned rock. CompoundPath and
	 *  boolean-unite masks fail to paint in Paper.js clipped groups, but one
	 *  group per rock (sharing the same pan/zoom) works reliably. */
	function buildBgFill() {
		removeBgFill();
		const bg = app.backgroundImageId;
		const el = bg ? imageEls.get(bg) : undefined;
		if (!el) return;
		const bgPaths = placed.filter((p) => !attach.has(p) && !solidOnly.has(p));
		if (bgPaths.length === 0) return;

		const groups: BgFillGroup[] = [];
		for (const path of bgPaths) {
			const clip = cloneRockGeometry(path);
			const raster = new paper.Raster(el);
			raster.scaling = new paper.Point(bgScale, bgScale);
			raster.position = bgCenter ?? paper.view.center;
			const group = new paper.Group([clip, raster]);
			group.clipped = true;
			paper.project.activeLayer.addChild(group);
			groups.push({ group, clip, raster, path });
			whenRasterReady(raster, () => {
				coverClamp(raster, clip.bounds);
				reapplyBg();
				for (const rock of placed) {
					if (!fills.has(rock)) rock.visible = false;
				}
				paper.view.update();
			});
		}
		bgFill = { groups };
	}

	/** The item that should play the settle-in: mask fill when present, else the solid path. */
	function placementVisual(path: paper.Path): paper.Item {
		const pin = fills.get(path);
		if (pin) return pin.group;
		const bg = bgFill?.groups.find((g) => g.path === path);
		if (bg) return bg.group;
		return path;
	}

	/** Bring every rock's fill in line with the current pins/background,
	 *  preserving manual pan/zoom on pins that don't change. */
	function syncFills() {
		if (!ready) return;
		ensureBgInit();

		// An image is either the background or pinned to one shape, never both:
		// drop any pin that points at the current background image.
		if (app.backgroundImageId) {
			for (const [path, id] of [...attach]) {
				if (id === app.backgroundImageId) attach.delete(path);
			}
		}

		// Per-instance pinned fills.
		for (const path of placed) {
			const pinned = attach.get(path);
			const want = pinned && imageEls.has(pinned) ? pinned : null;
			const cur = fills.get(path);
			if (!want) {
				if (cur) removeFill(path);
				continue;
			}
			if (cur && cur.imageId === want) continue;
			if (cur) removeFill(path);
			addPinFill(path, want);
		}
		for (const path of [...fills.keys()]) {
			if (!placed.includes(path)) removeFill(path);
		}

		// Single unified background behind all un-pinned rocks.
		buildBgFill();
		reapplyBg();

		// Un-pinned rocks hide behind the background union once its raster has
		// painted; pinned rocks hide once their own raster is ready.
		// solidOnly rocks always keep their solid fill visible.
		for (const path of placed) {
			if (solidOnly.has(path)) {
				path.visible = true;
				continue;
			}
			const pin = fills.get(path);
			if (pin) {
				path.visible = !pin.raster.loaded;
				continue;
			}
			path.visible = !bgFill || !bgFillReady();
		}
		if (selectedPaths.length) raiseSelectionVisuals();
		syncSelectionUi(selectedPaths.at(-1) ?? null);
	}

	/** Drop loaded elements + pins for images that no longer exist, then sync. */
	function refreshImages() {
		const ids = new Set(app.images.map((im) => im.id));
		for (const im of app.images) {
			if (!imageEls.has(im.id)) loadImage(im.id, im.src);
		}
		for (const id of [...imageEls.keys()]) {
			if (!ids.has(id)) imageEls.delete(id);
		}
		for (const [path, id] of [...attach]) {
			if (!ids.has(id)) attach.delete(path);
		}
		syncFills();
	}

	/** Fully rebuild fills from current geometry (after resize/shuffle). */
	function rebuildFills() {
		clearFills();
		bgCenter = null;
		bgId = null;
		syncFills();
	}

	/** Topmost image under a point: a pinned rock, or the unified background. */
	function hitAt(point: paper.Point): Hit | null {
		for (let i = placed.length - 1; i >= 0; i--) {
			const path = placed[i];
			if (!path.contains(point)) continue;
			const fill = fills.get(path);
			if (fill) return { kind: 'pin', fill };
			if (bgFill) return { kind: 'bg', fill: bgFill };
			return null;
		}
		return null;
	}

	/** Topmost placed rock instance under a point, regardless of its fill. */
	function shapeAt(point: paper.Point): paper.Path | null {
		for (let i = placed.length - 1; i >= 0; i--) {
			if (placed[i].contains(point)) return placed[i];
		}
		return null;
	}

	/** The fill currently being edited (bg or pin for imageEditId), if any. */
	function activeEditHit(): Hit | null {
		const id = app.imageEditId;
		if (!id) return null;
		if (id === app.backgroundImageId && bgFill) return { kind: 'bg', fill: bgFill };
		const pin = [...fills.values()].find((f) => f.imageId === id);
		if (pin) return { kind: 'pin', fill: pin };
		return null;
	}

	/** Hit-test the editable image by ghost bounds (full unclipped image), with fallback to masked shapes that show this image. */
	function editImageAt(point: paper.Point): Hit | null {
		const hit = activeEditHit();
		if (!hit) return null;
		if (editGhost?.bounds.contains(point)) return hit;
		// Fallback: still allow interaction inside shapes showing this edit image
		// (e.g. if ghost briefly missing). Reuse hitAt but only accept matching image.
		const shapeHit = hitAt(point);
		if (!shapeHit) return null;
		if (hit.kind === 'bg' && shapeHit.kind === 'bg') return hit;
		if (
			hit.kind === 'pin' &&
			shapeHit.kind === 'pin' &&
			shapeHit.fill.imageId === hit.fill.imageId
		)
			return hit;
		return null;
	}

	/** Toggle the image being edited onto a shape (or remove it from that shape). */
	function toggleImageMask(path: paper.Path) {
		const id = app.imageEditId;
		if (!id) return;
		if (attach.get(path) === id) {
			attach.delete(path);
		} else {
			if (app.backgroundImageId === id) app.backgroundImageId = null;
			for (const [p, iid] of [...attach]) {
				if (iid === id) attach.delete(p);
			}
			attach.set(path, id);
			solidOnly.delete(path);
		}
		syncFills();
	}

	function maskAllDuringEdit() {
		const id = app.imageEditId;
		if (!id) return;
		app.backgroundImageId = id;
		for (const [path, iid] of [...attach]) {
			if (iid === id) attach.delete(path);
		}
		// Re-include every rock, including ones previously released from the mask.
		solidOnly = new WeakSet();
		syncFills();
	}

	function saveImageEditSession() {
		imageEditBaseline = null;
		app.saveImageEdit();
		commitHistory();
	}

	function cancelImageEditSession() {
		if (imageEditBaseline) {
			historyRecording = false;
			restoreSnapshot(imageEditBaseline);
			historyRecording = true;
		}
		imageEditBaseline = null;
		app.cancelImageEdit();
	}

	/** Apply the active palette color to an already-placed rock. */
	function recolorShape(path: paper.Path): boolean {
		if (isLocked(path)) return false;
		if (attach.has(path)) return false;
		if (app.backgroundImageId && !solidOnly.has(path)) return false;
		const hex = app.nextColor.hex;
		const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
		const slot = colorSlotForHex(hex);
		const meta = rockMeta.get(path);
		if (meta) {
			rockMeta.set(path, { ...meta, colorSlot: slot });
		} else {
			writeRockMeta(path, {
				rockIndex: app.rockIndex,
				sizeIndex: app.sizeIndex,
				rotation: path.rotation,
				colorSlot: slot
			});
		}
		if (cur === hex) return false;
		path.fillColor = new paper.Color(hex);
		return true;
	}

	function syncColorFromShape(path: paper.Path) {
		const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
		if (!cur) return;
		const idx = rockColorIndex(cur);
		if (idx >= 0 && app.isRockColorAvailable(idx)) {
			app.selectColor(idx);
			selectedColorIndex = idx;
		}
	}

	function updateTipPos(force = false) {
		if (tipLocked && !force) return;
		if (!selectedPaths.length || !canvasEl || !selectedPaths.every((p) => placed.includes(p))) {
			tipPos = null;
			tipAnchor = null;
			return;
		}
		const rect = canvasEl.getBoundingClientRect();
		let cx: number;
		let cy: number;
		if (selectedPaths.length === 1) {
			const c = selectedPaths[0]!.bounds.center;
			cx = c.x;
			cy = c.y;
		} else {
			let left = Infinity;
			let top = Infinity;
			let right = -Infinity;
			let bottom = -Infinity;
			for (const p of selectedPaths) {
				const b = p.bounds;
				if (b.left < left) left = b.left;
				if (b.top < top) top = b.top;
				if (b.right > right) right = b.right;
				if (b.bottom > bottom) bottom = b.bottom;
			}
			cx = (left + right) / 2;
			cy = (top + bottom) / 2;
		}
		tipAnchor = {
			x: rect.left + cx,
			y: rect.top + cy
		};
		requestAnimationFrame(placeTip);
	}

	/** Shared palette index for the selection, or -1 when colors are mixed / unknown. */
	function sharedSelectionColorIndex(paths: paper.Path[]): number {
		let shared: number | null = null;
		for (const p of paths) {
			const cur = (p.fillColor as paper.Color | null)?.toCSS(true);
			const idx = cur ? rockColorIndex(cur) : -1;
			if (idx < 0) return -1;
			if (shared === null) shared = idx;
			else if (shared !== idx) return -1;
		}
		return shared ?? -1;
	}

	function syncSelectionUi(path: paper.Path | null) {
		if (!path) {
			tipPos = null;
			tipAnchor = null;
			selectedMaskSrc = null;
			selectedMaskId = null;
			selectedLocked = false;
			updateEditGhost();
			return;
		}
		const meta = rockMeta.get(path);
		selectedRockIndex = meta?.rockIndex ?? 0;
		selectedSizeIndex = meta?.sizeIndex ?? app.sizeIndex;
		const shared = sharedSelectionColorIndex(selectedPaths.length ? selectedPaths : [path]);
		// Single selection with an unknown fill falls back to the placement palette;
		// multi with mixed/unknown fills shows no active swatch.
		selectedColorIndex =
			shared >= 0 ? shared : selectedPaths.length > 1 ? -1 : app.colorIndex;
		const sel = selectedPaths.length ? selectedPaths : [path];
		selectedLocked = sel.length > 0 && sel.every((p) => !!rockMeta.get(p)?.locked);

		const pinId = attach.get(path);
		const bgId = app.backgroundImageId;
		const maskId =
			pinId ?? (bgId && !solidOnly.has(path) ? bgId : null);
		selectedMaskId = maskId;
		selectedMaskSrc = maskId ? (app.imageById(maskId)?.src ?? null) : null;
		updateTipPos();
		updateEditGhost();
	}

	function toggleSelectedLock() {
		if (!selectedPaths.length) return;
		const next = !selectedLocked;
		for (const p of selectedPaths) {
			const meta = rockMeta.get(p);
			if (meta) rockMeta.set(p, { ...meta, locked: next });
			else
				rockMeta.set(p, {
					rockIndex: 0,
					sizeIndex: app.sizeIndex,
					rotation: p.rotation,
					colorSlot: colorSlotForHex(
						(p.fillColor as paper.Color | null)?.toCSS(true) ?? app.nextColor.hex
					),
					locked: next
				});
		}
		selectedLocked = next;
		updateSelectionVisuals();
		commitHistory();
	}

	/** True when any selected rock is locked (blocks move / rotate / edits). */
	function selectionHasLocked(): boolean {
		return selectedPaths.some(isLocked);
	}

	/** Release this rock from its image mask so solid colors return. */
	function releaseSelectedMask() {
		if (selectedPaths.length !== 1 || !selectedPath || !placed.includes(selectedPath)) return;
		if (isLocked(selectedPath)) return;
		const path = selectedPath;
		const pinId = attach.get(path);
		if (pinId) {
			attach.delete(path);
		} else if (app.backgroundImageId && !solidOnly.has(path)) {
			solidOnly.add(path);
		} else {
			return;
		}
		syncFills();
		commitHistory();
	}

	/** Open mask editing for the image currently on the selected rock. */
	function editSelectedMask() {
		if (selectedPaths.length !== 1 || !selectedMaskId || selectionHasLocked()) return;
		app.startImageEdit(selectedMaskId);
	}

	function selectShape(path: paper.Path | null, syncColor = false) {
		selectedPaths = path ? [path] : [];
		if (path) {
			app.selectCursorTool();
			if (syncColor) syncColorFromShape(path);
		}
		syncSelectionUi(path);
		updateSelectionVisuals();
		updateGhost();
	}

	function toggleSelectShape(path: paper.Path, syncColor = false) {
		const idx = selectedPaths.indexOf(path);
		const next =
			idx >= 0 ? selectedPaths.filter((p) => p !== path) : [...selectedPaths, path];
		selectedPaths = next;
		if (next.length) {
			app.selectCursorTool();
			const primary = next[next.length - 1]!;
			// Only sync the global palette for a single selection — otherwise
			// changing app.colorIndex would recolor every selected rock.
			if (syncColor && next.length === 1) syncColorFromShape(primary);
			syncSelectionUi(primary);
		} else {
			syncSelectionUi(null);
		}
		updateSelectionVisuals();
		updateGhost();
	}

	function clearMarquee() {
		if (marqueePath) {
			marqueePath.remove();
			marqueePath = null;
		}
	}

	function updateMarqueeVisual(start: paper.Point, current: paper.Point) {
		clearMarquee();
		const rect = new paper.Rectangle(start, current);
		marqueePath = new paper.Path.Rectangle(rect);
		marqueePath.strokeColor = new paper.Color('#101A31');
		marqueePath.strokeWidth = 1.5;
		marqueePath.dashArray = [5, 4];
		const fill = new paper.Color('#101A31');
		fill.alpha = 0.08;
		marqueePath.fillColor = fill;
		marqueePath.opacity = 0.55;
		paper.project.activeLayer.addChild(marqueePath);
		marqueePath.bringToFront();
	}

	function applyMarqueeSelection(
		rect: paper.Rectangle,
		additive: boolean,
		baseline: paper.Path[]
	) {
		const hits = placed.filter((p) => p.bounds.intersects(rect));
		const next = additive
			? [...baseline, ...hits.filter((p) => !baseline.includes(p))]
			: hits;
		selectedPaths = next;
		if (next.length) {
			app.selectCursorTool();
			const primary = next[next.length - 1]!;
			if (next.length === 1) syncColorFromShape(primary);
			syncSelectionUi(primary);
		} else {
			syncSelectionUi(null);
		}
		updateSelectionVisuals();
		updateGhost();
	}

	/** Scale factor for a given size index at the current artboard. */
	function scaleForSize(sizeIndex: number): number {
		return (ROCK_SIZES[sizeIndex].fraction * Math.sqrt(artboard.w * artboard.h)) / ROCK_HEIGHT;
	}

	/** Rebuild a placed rock's outline as a different shape/size in place.
	 *  Keeps the current center (no jump). Overflowing the artboard is allowed;
	 *  only overlap with other rocks blocks the change (reverts + tip shake). */
	function reshapeSelected(nextRock: number, nextSize: number): boolean {
		if (selectedPaths.length !== 1 || !selectedPath || !placed.includes(selectedPath)) return false;
		if (isLocked(selectedPath)) return false;
		const path = selectedPath;
		const meta = rockMeta.get(path);
		if (meta?.rockIndex === nextRock && meta?.sizeIndex === nextSize) return false;

		const center = path.bounds.center.clone();
		const rotation = meta?.rotation ?? path.rotation;
		const fill = (path.fillColor as paper.Color | null)?.clone() ?? new paper.Color(app.nextColor.hex);
		const beforePathData = path.pathData;
		const beforeMeta = meta
			? { ...meta }
			: {
					rockIndex: 0,
					sizeIndex: app.sizeIndex,
					rotation,
					colorSlot: colorSlotForHex(
						(path.fillColor as paper.Color | null)?.toCSS(true) ?? app.nextColor.hex
					)
				};
		const savedAnchor = tipAnchor ? { ...tipAnchor } : null;
		const savedTip = tipPos ? { ...tipPos } : null;
		tipLocked = true;

		const next = sourcePaths[nextRock].clone({ insert: false }) as paper.Path;
		next.scale(scaleForSize(nextSize));
		next.rotate(rotation);
		next.position = center;
		next.fillColor = fill;

		path.pathData = next.pathData;
		path.fillColor = fill;
		next.remove();
		invalidateSamples(path);
		rebuildFromPath(path);

		const others = placed.filter((p) => p !== path);
		if (pathOverlapsAny(path, others)) {
			path.pathData = beforePathData;
			path.fillColor = fill;
			invalidateSamples(path);
			rebuildFromPath(path);
			rockMeta.set(path, beforeMeta);
			tipLocked = false;
			if (savedAnchor) tipAnchor = savedAnchor;
			if (savedTip) tipPos = savedTip;
			shakeTip();
			updateSelectionVisuals();
			return false;
		}

		rockMeta.set(path, {
			rockIndex: nextRock,
			sizeIndex: nextSize,
			rotation,
			colorSlot:
				meta?.colorSlot ??
				colorSlotForHex((path.fillColor as paper.Color | null)?.toCSS(true) ?? app.nextColor.hex),
			locked: meta?.locked
		});
		selectedRockIndex = nextRock;
		selectedSizeIndex = nextSize;

		finalizeShapeTransform();
		tipLocked = false;
		// Restore the tip where it was before the rock moved.
		if (savedAnchor) tipAnchor = savedAnchor;
		if (savedTip) tipPos = savedTip;
		else requestAnimationFrame(placeTip);
		return true;
	}

	function shakeTip() {
		tipShake = false;
		requestAnimationFrame(() => {
			tipShake = true;
			if (tipShakeTimer) clearTimeout(tipShakeTimer);
			tipShakeTimer = setTimeout(() => {
				tipShake = false;
				tipShakeTimer = null;
			}, 420);
		});
	}

	function setSelectedColor(i: number) {
		if (!selectedPaths.length) return;
		app.selectColor(i);
	}

	function setSelectedRock(i: number) {
		if (selectedPaths.length !== 1 || selectionHasLocked()) return;
		if (reshapeSelected(i, selectedSizeIndex)) commitHistory();
	}

	function setSelectedSize(i: number) {
		if (selectedPaths.length !== 1 || selectionHasLocked()) return;
		if (reshapeSelected(selectedRockIndex, i)) commitHistory();
	}

	function cycleSelectedRock() {
		setSelectedRock((selectedRockIndex + 1) % ROCK_SVGS.length);
	}

	function cycleSelectedSize() {
		setSelectedSize((selectedSizeIndex + 1) % ROCK_SIZES.length);
	}

	function clearEditGhost() {
		editGhost?.remove();
		editGhost = null;
	}

	/** Show a faint full-frame copy of the mask image so pan/zoom is visible. */
	function updateEditGhost() {
		if (!ready) {
			clearEditGhost();
			return;
		}
		const editId = app.imageEditId;
		const maskId = editId ?? selectedMaskId;
		if (!maskId) {
			clearEditGhost();
			return;
		}
		// Only preview while editing, or while a single masked rock is selected.
		if (!editId && selectedPaths.length !== 1) {
			clearEditGhost();
			return;
		}
		const el = imageEls.get(maskId);
		if (!el) {
			clearEditGhost();
			return;
		}

		let pos: paper.Point | null = null;
		let scale = 1;
		if (editId === app.backgroundImageId || (!editId && maskId === app.backgroundImageId)) {
			if (!bgCenter) {
				clearEditGhost();
				return;
			}
			pos = bgCenter;
			scale = bgScale;
		} else {
			// Prefer the selected rock's pin, else any pin of this image.
			const pin =
				(selectedPath ? fills.get(selectedPath) : undefined) ??
				[...fills.values()].find((f) => f.imageId === maskId);
			if (!pin || pin.imageId !== maskId) {
				clearEditGhost();
				return;
			}
			pos = pin.raster.position;
			scale = pin.raster.scaling.x;
		}

		if (!editGhost || (editGhost.data as { imageId?: string } | undefined)?.imageId !== maskId) {
			clearEditGhost();
			editGhost = new paper.Raster(el);
			editGhost.data = { imageId: maskId };
			editGhost.locked = true;
			paper.project.activeLayer.addChild(editGhost);
		}
		editGhost.scaling = new paper.Point(scale, scale);
		editGhost.position = pos;
		editGhost.opacity = app.imageEditId ? 0.32 : 0.22;
		editGhost.sendToBack();
	}

	function raiseSelectionVisuals() {
		for (const outline of selectionOutlines) outline.bringToFront();
	}

	function updateSelectionOutline() {
		for (const outline of selectionOutlines) outline.remove();
		selectionOutlines = [];
		const next = selectedPaths.filter((p) => placed.includes(p));
		if (next.length !== selectedPaths.length) {
			selectedPaths = next;
			syncSelectionUi(next.at(-1) ?? null);
		}
		if (!selectedPaths.length) return;
		for (const path of selectedPaths) {
			const outline = cloneRockGeometry(path);
			const locked = isLocked(path);
			outline.strokeColor = new paper.Color(locked ? '#2F6FED' : '#101A31');
			outline.strokeWidth = locked ? 2 : 1.5;
			outline.dashArray = locked ? [] : [5, 4];
			outline.fillColor = null;
			outline.opacity = locked ? 0.9 : 0.55;
			paper.project.activeLayer.addChild(outline);
			selectionOutlines.push(outline);
		}
		raiseSelectionVisuals();
	}

	function updateSelectionVisuals() {
		updateSelectionOutline();
	}

	/** Free move: follow the cursor, nestle flush against collisions. */
	function moveShapesTo(
		paths: paper.Path[],
		point: paper.Point,
		grabOffset: paper.Point
	): boolean {
		const primary = paths[0];
		if (!primary) return false;
		const target = point.add(grabOffset);
		const delta = target.subtract(primary.position);
		if (delta.length < 1e-6) return true;
		return moveKinematic(paths, delta);
	}

	/** Rotate a placed rock without overlapping others (off-center pivot if needed). */
	function rotateShapeFree(
		path: paper.Path,
		degrees: number,
		ignore: Set<paper.Path> = new Set()
	): boolean {
		const meta = rockMeta.get(path);
		const beforeRotation = meta?.rotation ?? path.rotation;
		const others = placed.filter((p) => p !== path && !ignore.has(p));

		const applied = rotateKinematic([path], degrees, others);
		if (Math.abs(applied) < 1e-4) return false;
		if (meta) {
			rockMeta.set(path, {
				...meta,
				rotation: ((beforeRotation + applied) % 360 + 360) % 360
			});
		}
		return true;
	}

	/** Rotate selected rocks. Single: around its own center (or a contact /
	 *  off-center pivot when blocked). Multi: around the selection's shared
	 *  center as a rigid body, with the same free-angle / alternate-pivot rules.
	 *  Never commits an overlapping pose. */
	function rotateSelectedShapes(degrees: number): boolean {
		if (!selectedPaths.length || selectionHasLocked()) return false;
		if (selectedPaths.length === 1) {
			return rotateShapeFree(selectedPaths[0]!, degrees);
		}

		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (const p of selectedPaths) {
			const b = p.bounds;
			if (b.left < left) left = b.left;
			if (b.top < top) top = b.top;
			if (b.right > right) right = b.right;
			if (b.bottom > bottom) bottom = b.bottom;
		}
		const pivot = new paper.Point((left + right) / 2, (top + bottom) / 2);

		const ignore = new Set(selectedPaths);
		const others = placed.filter((p) => !ignore.has(p));
		const befores = selectedPaths.map((p) => ({
			path: p,
			meta: rockMeta.get(p),
			rotation: rockMeta.get(p)?.rotation ?? p.rotation
		}));

		const applied = rotateKinematic(selectedPaths, degrees, others, pivot);
		if (Math.abs(applied) < 1e-4) return false;

		for (const b of befores) {
			if (!b.meta) continue;
			rockMeta.set(b.path, {
				...b.meta,
				rotation: ((b.rotation + applied) % 360 + 360) % 360
			});
		}
		return true;
	}

	/** After moving or rotating a rock, rebuild fills and regroup contacts. */
	function finalizeShapeTransform() {
		syncFills();
		cullOffCanvasPlaced();
		updateSelectionVisuals();
		recomputeGroups();
	}

	/** Remove a placed rock and any image fill pinned to it. */
	function eraseShape(path: paper.Path): boolean {
		if (isLocked(path)) return false;
		const idx = placed.indexOf(path);
		if (idx === -1) return false;
		removeFill(path);
		attach.delete(path);
		removeBody(path);
		path.remove();
		placed.splice(idx, 1);
		const next = selectedPaths.filter((p) => p !== path);
		if (next.length !== selectedPaths.length) {
			selectedPaths = next;
			if (!next.length) {
				selectShape(null);
			} else {
				syncSelectionUi(next[next.length - 1]!);
				updateSelectionVisuals();
			}
		}
		recomputeGroups();
		if (app.backgroundImageId) syncFills();
		app.placedCount = placed.length;
		return true;
	}

	/** True when any part of the rock outline sits on the artboard.
	 *  AABB `intersects` alone keeps 1px edge kisses that look invisible. */
	function rockVisibleOnArtboard(path: paper.Path, bounds: paper.Rectangle): boolean {
		const b = path.bounds;
		if (b.width < 1e-6 || b.height < 1e-6) return false;
		if (!b.intersects(bounds)) return false;
		const len = path.length;
		if (len <= 0) return bounds.contains(b.center);
		const n = Math.max(12, Math.min(48, Math.round(len / 10)));
		for (let i = 0; i < n; i++) {
			const pt = path.getPointAt((len * i) / n);
			if (pt && bounds.contains(pt)) return true;
		}
		return bounds.contains(path.interiorPoint);
	}

	/** Drop rocks that aren't meaningfully on the artboard. They still collide
	 *  and read as phantom walls after an aspect change or off-canvas drag. */
	function cullOffCanvasPlaced(bounds: paper.Rectangle = viewBounds()): boolean {
		if (placed.length === 0) return false;
		const kept: paper.Path[] = [];
		let removed = false;
		for (const rock of placed) {
			if (rockVisibleOnArtboard(rock, bounds)) {
				kept.push(rock);
				continue;
			}
			removed = true;
			removeFill(rock);
			attach.delete(rock);
			solidOnly.delete(rock);
			removeBody(rock);
			rock.remove();
		}
		if (!removed) return false;

		placed = kept;
		const nextSel = selectedPaths.filter((p) => kept.includes(p));
		if (nextSel.length !== selectedPaths.length) {
			selectedPaths = nextSel;
			if (!nextSel.length) {
				selectShape(null);
			} else {
				syncSelectionUi(nextSel[nextSel.length - 1]!);
				updateSelectionVisuals();
			}
		}
		recomputeGroups();
		if (app.backgroundImageId || attach.size) syncFills();
		app.placedCount = placed.length;
		updateTipPos();
		return true;
	}

	function findGroup(i: number): number {
		while (groupParent[i] !== i) {
			groupParent[i] = groupParent[groupParent[i]];
			i = groupParent[i];
		}
		return i;
	}

	function getComponent(path: paper.Path): paper.Path[] {
		const idx = placed.indexOf(path);
		if (idx === -1) return [path];
		const root = findGroup(idx);
		return placed.filter((_, j) => findGroup(j) === root);
	}

	let aspect = $derived(ASPECTS.find((a) => a.id === app.aspect)!);

	let artboard = $derived.by(() => {
		const availW = Math.max(stageW - STAGE_PADDING * 2, 0);
		const availH = Math.max(stageH - STAGE_PADDING * 2 - BG_BAR_SPACE, 0);
		const ratio = aspect.w / aspect.h;
		let w = availW;
		let h = w / ratio;
		if (h > availH) {
			h = availH;
			w = h * ratio;
		}
		return { w: Math.max(Math.round(w), 1), h: Math.max(Math.round(h), 1) };
	});

	// Scale factor for the source rocks (normalized to ROCK_HEIGHT tall) so
	// the tallest rock spans the chosen fraction of sqrt(canvas area) —
	// tying size to the canvas itself, independent of aspect ratio.
	let sizeScale = $derived(
		(app.rockSize.fraction * Math.sqrt(artboard.w * artboard.h)) / ROCK_HEIGHT
	);

	function viewBounds(): paper.Rectangle {
		return new paper.Rectangle(0, 0, paper.view.viewSize.width, paper.view.viewSize.height);
	}

	/** Convert a browser client point to paper view coordinates. Works outside
	 *  the canvas rect so drags/placement can continue past the artboard edge. */
	function clientToView(clientX: number, clientY: number): paper.Point | null {
		if (!canvasEl || !ready) return null;
		const rect = canvasEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		const x = ((clientX - rect.left) / rect.width) * paper.view.viewSize.width;
		const y = ((clientY - rect.top) / rect.height) * paper.view.viewSize.height;
		return new paper.Point(x, y);
	}

	/** Scaled clone of the active rock at the cursor. Placeable when it does
	 *  not overlap any existing rock. Artboard overflow is always allowed —
	 *  the cursor (and the rock) may sit outside the canvas. */
	function makePlacementCandidate(point: paper.Point) {
		const cand = sourcePaths[app.rockIndex].clone({ insert: false }) as paper.Path;
		cand.scale(sizeScale);
		cand.rotate(app.rotation);
		cand.position = point;
		const blocked = pathOverlapsAny(cand, placed);
		return { cand, placeable: !blocked };
	}

	/** White stroke on dark canvas bgs, ink on light/transparent — keeps ghosts readable. */
	function ghostContrastStroke(): paper.Color {
		const bg = app.canvasBg;
		if (!bg) return new paper.Color('#101A31');
		const c = new paper.Color(bg);
		const lum = 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue;
		return new paper.Color(lum < 0.45 ? '#FFFFFF' : '#101A31');
	}

	function styleGhostPath(path: paper.Path, fill: paper.Color, strokeAlpha: number) {
		const stroke = ghostContrastStroke();
		stroke.alpha = strokeAlpha;
		path.fillColor = fill;
		path.strokeColor = stroke;
		path.strokeWidth = 1.5;
		path.dashArray = [5, 4];
		path.opacity = 1;
	}

	function updateGhost() {
		if (performance.now() < ghostSuppressedUntil) return;

		ghost?.remove();
		ghost = null;
		if (!pointer || !ready || app.imageEditId || app.canvasTool !== 'shape' || selectedPaths.length)
			return;

		// Don't show a placement ghost over existing rocks — click to select instead.
		if (shapeAt(pointer)) return;

		const { cand, placeable } = makePlacementCandidate(pointer);

		// At unplaceable spots, show a faint contrasting hint — clicks do nothing there.
		if (!placeable) {
			cand.remove();
			const hint = sourcePaths[app.rockIndex].clone({ insert: false }) as paper.Path;
			hint.scale(sizeScale);
			hint.rotate(app.rotation);
			hint.position = pointer;
			const fill = ghostContrastStroke();
			fill.alpha = 0.12;
			styleGhostPath(hint, fill, 0.55);
			paper.project.activeLayer.addChild(hint);
			ghost = hint;
			return;
		}

		paper.project.activeLayer.addChild(cand);
		const fill = new paper.Color(app.nextColor.hex);
		fill.alpha = 0.65;
		styleGhostPath(cand, fill, 0.8);
		ghost = cand;
	}

	/** Fade the placement ghost out so the settle-in isn't covered by it. */
	function dismissGhost() {
		for (const id of ghostFadeRafs) cancelAnimationFrame(id);
		ghostFadeRafs.clear();
		if (ghostResumeTid !== null) {
			clearTimeout(ghostResumeTid);
			ghostResumeTid = null;
		}

		const fading = ghost;
		ghost = null;

		// Keep the ghost suppressed through the settle so mousemove doesn't rebuild it.
		ghostSuppressedUntil = performance.now() + 280;
		ghostResumeTid = setTimeout(() => {
			ghostResumeTid = null;
			ghostSuppressedUntil = 0;
			updateGhost();
		}, 280);

		if (!fading || !fading.project) return;

		const startOp = fading.opacity;
		const duration = 120;
		const t0 = performance.now();
		let rafId = 0;

		const frame = (now: number) => {
			ghostFadeRafs.delete(rafId);
			if (!fading.project) return;
			const t = Math.min(1, (now - t0) / duration);
			fading.opacity = startOp * (1 - t);
			paper.view.update();
			if (t < 1) {
				rafId = requestAnimationFrame(frame);
				ghostFadeRafs.add(rafId);
				return;
			}
			fading.remove();
			paper.view.update();
		};

		rafId = requestAnimationFrame(frame);
		ghostFadeRafs.add(rafId);
	}

	function cancelSlamAnimations() {
		slamGeneration++;
		for (const id of slamRafs) cancelAnimationFrame(id);
		slamRafs.clear();
		for (const id of slamTimeouts) clearTimeout(id);
		slamTimeouts.clear();
	}

	function easeOutCubic(t: number) {
		return 1 - Math.pow(1 - t, 3);
	}

	/** Soft settle-in for a newly placed rock — fade, light drop, no bounce.
	 *  Animates the visible item (mask fill group when masked, else the solid path). */
	function slamRock(
		path: paper.Path,
		opts?: { delay?: number; onComplete?: () => void }
	): Promise<void> {
		const delay = opts?.delay ?? 0;
		const gen = slamGeneration;
		const visual = placementVisual(path);

		// Hide immediately so nothing flashes at the final pose before the settle.
		visual.opacity = 0;
		if (visual !== path) path.opacity = 0;

		return new Promise((resolve) => {
			const done = (completed: boolean) => {
				if (completed) opts?.onComplete?.();
				resolve();
			};

			const run = () => {
				if (gen !== slamGeneration || !path.project || !visual.project) {
					done(false);
					return;
				}

				const land = visual.position.clone();
				const drop = Math.min(22, Math.max(14, path.bounds.height * 0.12));
				const startScale = 0.9;
				const duration = 260;

				let prevS = 1;
				const pivot = () => visual.bounds.center.clone();

				visual.position = new paper.Point(land.x, land.y - drop);
				visual.scale(startScale, startScale, pivot());
				prevS = startScale;
				visual.opacity = 0;
				paper.view.update();

				const t0 = performance.now();
				let rafId = 0;

				const frame = (now: number) => {
					slamRafs.delete(rafId);
					if (gen !== slamGeneration || !path.project || !visual.project) {
						done(false);
						return;
					}

					const t = Math.min(1, (now - t0) / duration);
					const u = easeOutCubic(t);
					const s = startScale + (1 - startScale) * u;

					visual.scale(s / prevS, s / prevS, pivot());
					prevS = s;
					visual.position = new paper.Point(land.x, land.y - drop * (1 - u));
					visual.opacity = u;
					paper.view.update();

					if (t < 1) {
						rafId = requestAnimationFrame(frame);
						slamRafs.add(rafId);
						return;
					}

					visual.position = land;
					visual.opacity = 1;
					if (prevS !== 1) visual.scale(1 / prevS, 1 / prevS, pivot());
					// Solid path stayed at the final pose; only restore opacity.
					if (visual !== path) path.opacity = 1;
					paper.view.update();
					done(true);
				};

				rafId = requestAnimationFrame(frame);
				slamRafs.add(rafId);
			};

			if (delay <= 0) {
				run();
				return;
			}
			const tid = setTimeout(() => {
				slamTimeouts.delete(tid);
				run();
			}, delay);
			slamTimeouts.add(tid);
		});
	}

	function clearPlaced() {
		cancelSlamAnimations();
		clearFills();
		// Pins reference instances that are about to be removed.
		attach.clear();
		clearBodies();
		for (const p of placed) p.remove();
		placed = [];
		groupParent = [];
		rockMeta = new WeakMap();
		solidOnly = new WeakSet();
		selectShape(null);
		placedArtboard = { w: artboard.w, h: artboard.h };
		app.placedCount = 0;
	}

	function isLocked(path: paper.Path): boolean {
		return !!rockMeta.get(path)?.locked;
	}

	/** Remove unlocked rocks only; return survivors that stay through generate. */
	function clearUnlockedPlaced(): paper.Path[] {
		const locked = placed.filter(isLocked);
		const unlocked = placed.filter((p) => !isLocked(p));
		console.log('[cairn:shuffle] clearUnlockedPlaced:before', {
			seed: app.shuffleSeed,
			placed: placed.length,
			locked: locked.length,
			unlocked: unlocked.length
		});
		debugPhysicsSnapshot('shuffle:before-clear', placed, {
			seed: app.shuffleSeed,
			locked: locked.length,
			unlocked: unlocked.length
		});
		cancelSlamAnimations();
		for (const p of unlocked) {
			removeFill(p);
			attach.delete(p);
			solidOnly.delete(p);
			p.remove();
		}
		placed = locked;
		groupParent = locked.map((_, i) => i);
		selectShape(null);
		// Wipe Matter entirely, then re-register only locked survivors — same
		// hard reset undo/restore uses, so prior-layout bodies cannot linger.
		resetBodies(locked);
		if (!locked.length) {
			clearFills();
			attach.clear();
			rockMeta = new WeakMap();
			solidOnly = new WeakSet();
		} else {
			// Drop orphaned bg/pin groups for removed rocks; keep locked fills.
			syncFills();
		}
		app.placedCount = placed.length;
		debugPhysicsSnapshot('shuffle:after-clear', placed, {
			seed: app.shuffleSeed,
			lockedKept: locked.length
		});
		return locked;
	}

	function layerPathSummary(): { totalChildren: number; pathChildren: number } {
		if (!ready || !paper.project?.activeLayer) {
			return { totalChildren: 0, pathChildren: 0 };
		}
		const children = paper.project.activeLayer.children;
		let pathChildren = 0;
		for (const child of children) {
			if (child instanceof paper.Path) pathChildren++;
		}
		return { totalChildren: children.length, pathChildren };
	}

	function resetOverlay() {
		for (const id of ghostFadeRafs) cancelAnimationFrame(id);
		ghostFadeRafs.clear();
		if (ghostResumeTid !== null) {
			clearTimeout(ghostResumeTid);
			ghostResumeTid = null;
		}
		ghostSuppressedUntil = 0;
		ghost?.remove();
		ghost = null;
		updateSelectionVisuals();
	}

	function clearCanvas() {
		clearPlaced();
		resetOverlay();
		updateGhost();
		commitHistory();
	}

	function escapeXml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function imageDataUrl(el: HTMLImageElement): string {
		if (el.src.startsWith('data:')) return el.src;
		const canvas = document.createElement('canvas');
		canvas.width = el.naturalWidth;
		canvas.height = el.naturalHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) return el.src;
		ctx.drawImage(el, 0, 0);
		return canvas.toDataURL('image/png');
	}

	function rasterSvgImage(el: HTMLImageElement, raster: paper.Raster): string {
		const dw = el.naturalWidth * raster.scaling.x;
		const dh = el.naturalHeight * raster.scaling.y;
		const x = raster.position.x - dw / 2;
		const y = raster.position.y - dh / 2;
		const href = escapeXml(imageDataUrl(el));
		return (
			`<image x="${x}" y="${y}" width="${dw}" height="${dh}" ` +
			`href="${href}" xlink:href="${href}" preserveAspectRatio="none"/>`
		);
	}

	/** Strip every interactive overlay so exports never bake in UI chrome. */
	function clearUiOverlays() {
		for (const id of ghostFadeRafs) cancelAnimationFrame(id);
		ghostFadeRafs.clear();
		if (ghostResumeTid !== null) {
			clearTimeout(ghostResumeTid);
			ghostResumeTid = null;
		}
		ghostSuppressedUntil = 0;
		ghost?.remove();
		for (const outline of selectionOutlines) outline.remove();
		clearMarquee();
		clearEditGhost();
		ghost = null;
		selectionOutlines = [];
	}

	function restoreUiOverlays() {
		updateSelectionVisuals();
		updateEditGhost();
		updateGhost();
	}

	/**
	 * Exports redraw from placed rocks + fills only — never the live Paper.js
	 * view — so selection outlines, placement ghosts, marquees, and edit
	 * previews cannot appear in the file.
	 *
	 * Before writing, only separate pairs whose Paper fills truly penetrate
	 * (Matter chord false-positives must not invent gaps). Live geometry is
	 * always restored afterward.
	 */
	function withCleanExport(run: () => void) {
		clearUiOverlays();
		const snapshot = placed.map((p) => ({ path: p, pathData: p.pathData }));
		try {
			settleContactsForExport(placed, viewBounds(), app.mode);
			syncFillClipsForPaths(placed);
			run();
		} finally {
			for (const s of snapshot) {
				s.path.pathData = s.pathData;
				invalidateSamples(s.path);
				rebuildFromPath(s.path);
			}
			syncFillClipsForPaths(placed);
			restoreUiOverlays();
		}
	}

	function exportSvg(transparentBg = false) {
		withCleanExport(() => {
			const w = Math.max(Math.round(artboard.w), 1);
			const h = Math.max(Math.round(artboard.h), 1);
			const body: string[] = [];
			const clips: string[] = [];
			let clipIdx = 0;

			if (!transparentBg && app.canvasBg) {
				body.push(`<rect width="${w}" height="${h}" fill="${escapeXml(app.canvasBg)}"/>`);
			}

			// Content only: solid fills and clipped image fills. No strokes/UI.
			for (const path of placed) {
				const fill = fills.get(path);
				const el = fill ? imageEls.get(fill.imageId) : undefined;
				if (fill && el) {
					const id = `clip-${clipIdx++}`;
					clips.push(
						`<clipPath id="${id}"><path d="${escapeXml(fill.clip.pathData)}"/></clipPath>`
					);
					body.push(`<g clip-path="url(#${id})">${rasterSvgImage(el, fill.raster)}</g>`);
					continue;
				}
				if (bgFill) continue;
				const color = path.fillColor as paper.Color | null;
				if (!color) continue;
				body.push(
					`<path d="${escapeXml(path.pathData)}" fill="${color.toCSS(true)}"/>`
				);
			}

			const bgEl = app.backgroundImageId ? imageEls.get(app.backgroundImageId) : undefined;
			if (bgFill && bgEl) {
				for (const { clip, raster } of bgFill.groups) {
					const id = `clip-${clipIdx++}`;
					clips.push(
						`<clipPath id="${id}"><path d="${escapeXml(clip.pathData)}"/></clipPath>`
					);
					body.push(`<g clip-path="url(#${id})">${rasterSvgImage(bgEl, raster)}</g>`);
				}
			}

			const defs = clips.length ? `<defs>${clips.join('')}</defs>` : '';
			const svg =
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
				`width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}${body.join('')}</svg>`;

			const link = document.createElement('a');
			link.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
			link.download = `cairn-${app.aspect.replace(':', 'x')}.svg`;
			link.click();
			URL.revokeObjectURL(link.href);
		});
	}

	function exportPng(transparentBg = false) {
		if (!canvasEl) return;

		withCleanExport(() => {
			const w = Math.max(Math.round(artboard.w), 1);
			const h = Math.max(Math.round(artboard.h), 1);
			const MAX_EXPORT_EDGE = 4096;
			const scale = Math.max(1, Math.floor(MAX_EXPORT_EDGE / Math.max(w, h)));

			const output = document.createElement('canvas');
			output.width = w * scale;
			output.height = h * scale;
			const ctx = output.getContext('2d');
			if (!ctx) return;

			// Leave empty for a transparent PNG; otherwise paint the chosen backdrop.
			if (!transparentBg && app.canvasBg) {
				ctx.fillStyle = app.canvasBg;
				ctx.fillRect(0, 0, output.width, output.height);
			}
			// Work in view coordinates; the scale gives a crisp high-res render.
			ctx.scale(scale, scale);

			// A paper Raster draws its image centered at `position`, sized by its
			// scaling times the natural pixels — replicate that with drawImage.
			const drawRaster = (el: HTMLImageElement, r: paper.Raster) => {
				const dw = el.naturalWidth * r.scaling.x;
				const dh = el.naturalHeight * r.scaling.y;
				ctx.drawImage(el, r.position.x - dw / 2, r.position.y - dh / 2, dw, dh);
			};

			// Content only: solid fills and clipped image fills. No strokes/UI.
			for (const path of placed) {
				const fill = fills.get(path);
				const el = fill ? imageEls.get(fill.imageId) : undefined;
				if (fill && el) {
					ctx.save();
					ctx.clip(new Path2D(fill.clip.pathData));
					drawRaster(el, fill.raster);
					ctx.restore();
					continue;
				}
				// Un-pinned rocks are drawn by the unified background group below.
				if (bgFill) continue;
				const color = path.fillColor as paper.Color | null;
				if (!color) continue;
				ctx.save();
				ctx.fillStyle = color.toCSS(true);
				ctx.fill(new Path2D(path.pathData));
				ctx.restore();
			}

			// The unified background image, masked by each un-pinned rock silhouette.
			const bgEl = app.backgroundImageId ? imageEls.get(app.backgroundImageId) : undefined;
			if (bgFill && bgEl) {
				for (const { clip, raster } of bgFill.groups) {
					ctx.save();
					ctx.clip(new Path2D(clip.pathData));
					drawRaster(bgEl, raster);
					ctx.restore();
				}
			}

			const link = document.createElement('a');
			link.href = output.toDataURL('image/png');
			link.download = `cairn-${app.aspect.replace(':', 'x')}.png`;
			link.click();
		});
	}

	function runShuffle() {
		if (!ready) return;
		const seed = app.shuffleSeed;
		const genIndex = seed; // seed increments per click; 1 = first, 2 = second
		console.group(`[cairn:shuffle] generate #${genIndex} seed=${seed} mode=${app.mode}`);
		console.log('[cairn:shuffle] start', {
			genIndex,
			seed,
			mode: app.mode,
			sizeIndex: app.sizeIndex,
			aspect: app.aspect,
			artboard: { w: artboard.w, h: artboard.h },
			layer: layerPathSummary(),
			placedBefore: placed.length
		});

		const lockedPaths = clearUnlockedPlaced();
		resetOverlay();

		const bounds = viewBounds();
		console.log('[cairn:shuffle] generating', {
			seed,
			bounds: {
				x: bounds.x,
				y: bounds.y,
				w: bounds.width,
				h: bounds.height
			},
			lockedObstacles: lockedPaths.length,
			enabledShapes: [...app.enabledShapes],
			enabledColors: [...app.enabledColors]
		});

		const rocks = generateShuffle(sourcePaths, bounds, {
			mode: app.mode,
			colors: app.enabledColors,
			shapes: app.enabledShapes,
			sizeIndex: app.sizeIndex,
			seed,
			obstacles: lockedPaths
		});
		console.log('[cairn:shuffle] generated paths', {
			seed,
			count: rocks.length,
			rocks: rocks.map((r, i) => {
				const data = r.data as {
					rockIndex?: number;
					sizeIndex?: number;
					rotation?: number;
				};
				const b = r.bounds;
				return {
					i,
					rockIndex: data?.rockIndex,
					sizeIndex: data?.sizeIndex,
					rotation: data?.rotation !== undefined ? +data.rotation.toFixed(1) : null,
					pos: { x: +r.position.x.toFixed(1), y: +r.position.y.toFixed(1) },
					bounds: {
						left: +b.left.toFixed(1),
						top: +b.top.toFixed(1),
						w: +b.width.toFixed(1),
						h: +b.height.toFixed(1)
					},
					onArtboard: rockVisibleOnArtboard(r, bounds)
				};
			})
		});

		// Mount the new composition, then rebuild Matter from that set alone.
		for (const rock of rocks) {
			paper.project.activeLayer.addChild(rock);
			placed.push(rock);
			groupParent.push(placed.length - 1);
			const data = rock.data as {
				rockIndex?: number;
				sizeIndex?: number;
				rotation?: number;
			} | undefined;
			rockMeta.set(rock, {
				rockIndex: data?.rockIndex ?? 0,
				sizeIndex: data?.sizeIndex ?? app.sizeIndex,
				rotation: data?.rotation ?? rock.rotation,
				colorSlot: colorSlotForHex(
					(rock.fillColor as paper.Color | null)?.toCSS(true) ?? app.nextColor.hex
				)
			});
		}

		debugPhysicsSnapshot('shuffle:after-mount-before-reposition', placed, {
			seed,
			genIndex,
			locked: lockedPaths.length
		});

		// Rocks were just generated at this canvas size, so anchor here without
		// rescaling; later artboard changes will scale from this baseline.
		// Skip recentering when locked rocks remain — it would move them.
		placedArtboard = { w: bounds.width, h: bounds.height };
		if (!lockedPaths.length) {
			repositionPlaced(bounds.width, bounds.height);
		} else {
			// repositionPlaced already culls; when skipped, still drop any newly
			// generated rocks that landed fully off the current artboard.
			cullOffCanvasPlaced(bounds);
		}

		// Final authority after layout/cull: collision world === visible rocks.
		resetBodies(placed);
		debugPhysicsSnapshot('shuffle:final', placed, {
			seed,
			genIndex,
			layer: layerPathSummary(),
			note: 'If orphans>0 or world.bodies>>links, prior bodies leaked into this layout'
		});

		recomputeGroups();
		if (app.backgroundImageId || attach.size) syncFills();
		app.placedCount = placed.length;
		selectShape(null);
		updateGhost();
		paper.view.update();
		commitHistory();
		console.log('[cairn:shuffle] done', {
			seed,
			genIndex,
			placed: placed.length,
			layer: layerPathSummary()
		});
		console.groupEnd();
	}

	function placeRock(point: paper.Point) {
		const { cand, placeable } = makePlacementCandidate(point);
		if (!placeable) {
			cand.remove();
			return;
		}

		// Placement animation disabled for shape tool — clear preview and land instantly.
		resetOverlay();

		paper.project.activeLayer.addChild(cand);
		cand.fillColor = new paper.Color(app.nextColor.hex);
		cand.strokeColor = null;
		cand.strokeWidth = 0;
		cand.dashArray = [];
		cand.opacity = 1;
		placed.push(cand);
		syncBody(cand);
		rockMeta.set(cand, {
			rockIndex: app.rockIndex,
			sizeIndex: app.sizeIndex,
			rotation: app.rotation,
			colorSlot: colorSlotForHex(app.nextColor.hex)
		});

		// Union the new rock with every placed rock it touches.
		const idx = placed.length - 1;
		groupParent.push(idx);
		for (let j = 0; j < idx; j++) {
			if (!placed[j].bounds.expand(GROUP_EPS * 4).intersects(cand.bounds)) continue;
			if (outlineDistance(cand, placed[j]) <= GROUP_EPS) {
				groupParent[findGroup(j)] = findGroup(idx);
			}
		}

		if (app.backgroundImageId) syncFills();

		app.placedCount++;
		cullOffCanvasPlaced();
		commitHistory();
	}

	/** Coalesce ghost updates to at most once per frame (paper + window moves). */
	function scheduleGhostUpdate() {
		if (ghostRaf) return;
		ghostRaf = requestAnimationFrame(() => {
			ghostRaf = 0;
			updateGhost();
		});
	}

	/** Shared move logic for paper.view and window pointer tracking. */
	function handleViewMove(point: paper.Point) {
		// While an image drag is active, pan the picture instead of updating
		// the placement ghost. (paper's View emits mousemove even with the
		// button held, so there's no separate drag event to use.) Background
		// images pan as one unified image; pinned images pan per-rock.
		if (imageDrag) {
			if (!app.imageEditId) {
				imageDrag = null;
				return;
			}
			const delta = point.subtract(imageDrag.last);
			imageDrag.last = point;
			if (imageDrag.kind === 'bg' && bgCenter) {
				bgCenter = bgCenter.add(delta);
				reapplyBg();
			} else if (imageDrag.kind === 'pin') {
				const f = imageDrag.fill as PinFill;
				f.raster.position = f.raster.position.add(delta);
				coverClamp(f.raster, f.clip.bounds);
				updateEditGhost();
			}
			didDragImage = true;
			if (canvasEl) canvasEl.style.cursor = 'grabbing';
			return;
		}
		if (shapeDrag) {
			const { paths, grabOffset } = shapeDrag;
			moveShapesTo(paths, point, grabOffset);
			// Keep image clips on the collision path (same as live rotate).
			syncFillClipsForPaths(paths);
			updateSelectionVisuals();
			updateTipPos();
			didDragShape = true;
			draggingShape = true;
			setShapeDragCursor(dragWouldDelete(paths));
			return;
		}
		if (marqueeDrag) {
			const dist = point.getDistance(marqueeDrag.start);
			if (dist >= MARQUEE_THRESHOLD) {
				didDragMarquee = true;
				draggingMarquee = true;
				updateMarqueeVisual(marqueeDrag.start, point);
				const rect = new paper.Rectangle(marqueeDrag.start, point);
				applyMarqueeSelection(rect, marqueeDrag.additive, marqueeDrag.baseline);
			}
			return;
		}
		if (canvasEl) {
			if (app.imageEditId) {
				const shape = shapeAt(point);
				const hit = editImageAt(point);
				canvasEl.style.cursor = hit ? 'grab' : shape ? 'copy' : '';
			} else {
				canvasEl.style.cursor = '';
			}
		}
		if (app.imageEditId) return;
		pointer = point;
		scheduleGhostUpdate();
	}

	/** Shared up logic — idempotent so paper + window can both call it. */
	function handleViewUp() {
		if (imageDrag && didDragImage && !app.imageEditId) commitHistory();
		if (shapeDrag && didDragShape) {
			endDrag(shapeDrag.paths);
			finalizeShapeTransform();
			cullOffCanvasPlaced();
			updateTipPos();
			commitHistory();
		} else if (shapeDrag) {
			endDrag(shapeDrag.paths);
		}
		if (marqueeDrag && didDragMarquee && marqueePath) {
			applyMarqueeSelection(marqueePath.bounds, marqueeDrag.additive, marqueeDrag.baseline);
		}
		clearMarquee();
		marqueeDrag = null;
		draggingMarquee = false;
		imageDrag = null;
		shapeDrag = null;
		draggingShape = false;
		clearShapeDragCursor();
	}

	function setupPaper() {
		if (!canvasEl) return;
		paper.setup(canvasEl);
		createWorld();
		setPathTranslateHook((path) => invalidateSamples(path));
		const w = window as unknown as {
			__paper: typeof paper;
			__bg: () => unknown;
			__CAIRN_DEBUG_PHYSICS?: boolean;
			__cairnDumpPhysics?: () => void;
		};
		if (w.__CAIRN_DEBUG_PHYSICS === undefined) w.__CAIRN_DEBUG_PHYSICS = true;
		w.__cairnDumpPhysics = () =>
			debugPhysicsSnapshot('manual-dump', placed, {
				seed: app.shuffleSeed,
				layer: layerPathSummary()
			});
		w.__paper = paper;
		w.__bg = () =>
			bgFill
				? {
						groupCount: bgFill.groups.length,
						autoUpdate: (paper.view as unknown as { autoUpdate: boolean }).autoUpdate,
						rasterLoaded: bgFill.groups.map((g) => g.raster.loaded),
						bgScale,
						bgCenter
					}
				: 'no bgFill';

		sourcePaths = ROCK_SVGS.map((svg) => {
			const group = paper.project.importSVG(svg, { insert: false });
			const path = (group.getItem({ class: paper.Path }) as paper.Path).clone({ insert: false });
			group.remove();
			// Templates are fill-only; strokes would leak into placement/export.
			path.strokeColor = null;
			path.strokeWidth = 0;
			return path;
		});

		// Apply one shared multiplier so the rocks keep their relative proportions:
		// the tallest rock becomes ROCK_HEIGHT, the rest scale by the same factor.
		const tallest = Math.max(...sourcePaths.map((p) => p.bounds.height));
		const factor = ROCK_HEIGHT / tallest;
		for (const p of sourcePaths) p.scale(factor);

		paper.view.onMouseMove = (event: paper.MouseEvent) => {
			handleViewMove(event.point);
		};
		// Leave only clears the canvas cursor; window pointermove keeps
		// updating `pointer` / drags / marquee past the artboard edge.
		paper.view.onMouseLeave = () => {
			// Keep the drag cursor (grab / trash) via body while off-canvas.
			if (shapeDrag) return;
			if (canvasEl) canvasEl.style.cursor = '';
		};
		paper.view.onMouseDown = (event: paper.MouseEvent) => {
			didDragImage = false;
			didDragShape = false;
			didDragMarquee = false;
			if (app.imageEditId) {
				const hit = editImageAt(event.point);
				if (hit) imageDrag = { kind: hit.kind, fill: hit.fill, last: event.point };
				return;
			}
			// Drop invisible / sliver-off-canvas rocks before hit-testing so they
			// cannot block placement or feel like phantom walls.
			cullOffCanvasPlaced();
			const shape = shapeAt(event.point);
			if (shape) {
				const shift =
					!!(event as paper.MouseEvent & { event?: MouseEvent }).event?.shiftKey || shiftHeld;
				if (shift) {
					toggleSelectShape(shape, true);
				} else if (!selectedPaths.includes(shape)) {
					selectShape(shape, true);
				}
				// else: keep existing multi-selection for group drag
				if (!selectedPaths.includes(shape)) {
					// was toggled off
					return;
				}
				// Locked rocks stay put — select only, no drag.
				if (selectedPaths.some(isLocked)) return;
				const paths = [shape, ...selectedPaths.filter((p) => p !== shape)];
				shapeDrag = {
					paths,
					grabOffset: shape.position.subtract(event.point)
				};
				beginDrag(paths, placed);
			} else {
				const additive =
					!!(event as paper.MouseEvent & { event?: MouseEvent }).event?.shiftKey || shiftHeld;
				marqueeDrag = {
					start: event.point.clone(),
					additive,
					baseline: [...selectedPaths]
				};
			}
		};
		paper.view.onMouseUp = () => {
			handleViewUp();
		};
		paper.view.onClick = (event: paper.MouseEvent) => {
			if (didDragImage || didDragShape || didDragMarquee) {
				didDragImage = false;
				didDragShape = false;
				didDragMarquee = false;
				return;
			}
			if (app.imageEditId) {
				const shape = shapeAt(event.point);
				if (shape) toggleImageMask(shape);
				return;
			}
			const shape = shapeAt(event.point);
			if (shape) {
				// Selection already handled on mousedown — don't wipe multi-select.
				return;
			}
			if (selectedPaths.length) {
				selectShape(null);
				return;
			}
			if (app.canvasTool === 'shape') placeRock(event.point);
		};

		ready = true;
		// One-shot: strip legacy Paper/Ink rock fills before the first history snapshot.
		coerceExcludedRockFills();
		initHistory();
	}

	onMount(() => {
		setupPaper();
		return () => {
			ready = false;
			canvasEl = null;
			cancelSlamAnimations();
			for (const id of ghostFadeRafs) cancelAnimationFrame(id);
			ghostFadeRafs.clear();
			if (ghostResumeTid !== null) {
				clearTimeout(ghostResumeTid);
				ghostResumeTid = null;
			}
			if (ghostRaf) cancelAnimationFrame(ghostRaf);
			setPathTranslateHook(null);
			destroyWorld();
			placed = [];
			groupParent = [];
			fills = new Map();
			attach = new Map();
			imageDrag = null;
			shapeDrag = null;
			clearMarquee();
			marqueeDrag = null;
			draggingMarquee = false;
			didDragMarquee = false;
			selectedPaths = [];
			selectionOutlines = [];
			bgCenter = null;
			bgId = null;
			paper.project.clear();
		};
	});

	function unitedBounds(): paper.Rectangle {
		return unitedBoundsOf(placed);
	}

	function unitedBoundsOf(paths: paper.Path[]): paper.Rectangle {
		let bounds = paths[0].bounds;
		for (let i = 1; i < paths.length; i++) bounds = bounds.unite(paths[i].bounds);
		return bounds;
	}

	/** Refit the placed arrangement to the current artboard: scale the whole
	 *  composition so rocks stay proportional to the canvas (using sqrt of area,
	 *  matching how rocks are sized at generation), then re-anchor —
	 *  bottom-center in stack mode, centered in cluster mode.
	 *  When any rocks are locked, scale pivots on the locked cluster's center
	 *  and skip re-anchoring so locked rocks stay put. */
	function repositionPlaced(w: number, h: number) {
		if (placed.length === 0) {
			placedArtboard = { w, h };
			return;
		}

		const locked = placed.filter(isLocked);

		const prevArea = placedArtboard.w * placedArtboard.h;
		if (prevArea > 0 && w > 0 && h > 0) {
			const factor = Math.sqrt((w * h) / prevArea);
			if (Math.abs(factor - 1) > 1e-4) {
				const pivot = (locked.length ? unitedBoundsOf(locked) : unitedBounds()).center;
				for (const p of placed) {
					p.scale(factor, pivot);
					invalidateSamples(p);
					rebuildFromPath(p);
				}
			}
		}
		placedArtboard = { w, h };

		// Skip re-anchor when locked rocks exist — scaling already centered on
		// them; translating would shove locked rocks toward artboard center.
		if (!locked.length) {
			const bounds = unitedBounds();
			const anchor = app.mode === 'stack' ? bounds.bottomCenter : bounds.center;
			const target =
				app.mode === 'stack' ? new paper.Point(w / 2, h) : new paper.Point(w / 2, h / 2);

			const delta = target.subtract(anchor);
			for (const p of placed) {
				p.translate(delta);
				invalidateSamples(p);
				rebuildFromPath(p);
			}
		}

		// Geometry moved/scaled, so fills (separate clip clones + rasters) are
		// stale: rebuild them against the new layout and shared baseline.
		rebuildFills();
		// Aspect / stage resize can leave rocks only visible on another ratio —
		// drop fully off-canvas ones so they cannot phantom-collide.
		cullOffCanvasPlaced(new paper.Rectangle(0, 0, w, h));
		updateSelectionVisuals();
		updateTipPos();
	}

	// Keep the Paper view sized to the computed artboard and refit the
	// placed rocks whenever it changes. Mode is untracked so toggling it
	// doesn't move existing rocks; it only affects the next refit.
	$effect(() => {
		if (!ready) return;
		paper.view.viewSize = new paper.Size(artboard.w, artboard.h);
		untrack(() => repositionPlaced(artboard.w, artboard.h));
	});

	// Shape tool and generate settings both clear selection (and its tip).
	$effect(() => {
		if (!ready) return;
		if (app.canvasTool !== 'shape' && app.toolPanel !== 'lucky') return;
		untrack(() => {
			if (selectedPaths.length) selectShape(null);
		});
	});

	// Rebuild the ghost when the active rock, upcoming color, size, rotation,
	// mode, or canvas background changes (stroke contrast depends on bg).
	$effect(() => {
		void app.rockIndex;
		void app.colorIndex;
		void sizeScale;
		void app.rotation;
		void app.mode;
		void app.canvasTool;
		void app.imageEditId;
		void app.canvasBg;
		void app.canvasBgVersion;
		updateGhost();
	});

	// Enter image edit: snapshot for cancel and clear shape selection.
	$effect(() => {
		if (!ready) return;
		const id = app.imageEditId;
		if (!id) {
			untrack(() => updateEditGhost());
			return;
		}
		untrack(() => {
			imageEditBaseline = captureSnapshot();
			selectShape(null);
			resetOverlay();
			updateEditGhost();
		});
	});

	// When shapes are selected, palette changes from the main toolbar recolor them.
	// Selection membership is untracked so shift-selecting another rock doesn't
	// recolor the whole set to the current palette color.
	$effect(() => {
		const idx = app.colorIndex;
		if (!ready || app.imageEditId) return;
		untrack(() => {
			if (app.skipSelectionColorApply) return;
			if (!selectedPaths.length) return;
			void idx;
			selectedColorIndex = idx;
			let changed = false;
			for (const path of selectedPaths) {
				if (recolorShape(path)) changed = true;
			}
			if (changed) commitHistory();
		});
	});

	// When the canvas background changes to a color rocks were using, swap those
	// fills to the previous background (or a fallback when leaving transparent).
	$effect(() => {
		if (!ready) return;
		const version = app.canvasBgVersion;
		if (version === seenCanvasBgVersion) return;
		seenCanvasBgVersion = version;
		untrack(() => {
			const swap = app.bgRecolor;
			if (!swap) {
				if (selectedPaths.length) syncSelectionUi(selectedPaths.at(-1) ?? null);
				return;
			}
			let changed = false;
			for (const path of placed) {
				const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
				if (!cur || !hexEq(cur, swap.from)) continue;
				path.fillColor = new paper.Color(swap.to);
				const meta = rockMeta.get(path);
				const slot = colorSlotForHex(swap.to);
				if (meta) rockMeta.set(path, { ...meta, colorSlot: slot });
				changed = true;
			}
			if (selectedPaths.length) syncSelectionUi(selectedPaths.at(-1) ?? null);
			updateGhost();
			if (changed) commitHistory();
		});
	});

	// Top-bar dice: sync rock fills from palette slots. Palette switch: randomize into new pool.
	$effect(() => {
		if (!ready) return;
		const shuffleVersion = app.colorShuffleVersion;
		const paletteVersion = app.paletteSwitchVersion;
		const shuffled = shuffleVersion !== seenColorShuffleVersion;
		const switched = paletteVersion !== seenPaletteSwitchVersion;
		if (!shuffled && !switched) return;
		seenColorShuffleVersion = shuffleVersion;
		seenPaletteSwitchVersion = paletteVersion;
		untrack(() => {
			let changed = false;

			if (shuffled) {
				changed = syncRocksFromColorSlots();
			} else if (switched) {
				const pool = app.enabledBgRockColors;
				if (!pool.length) return;
				for (const path of placed) {
					if (isLocked(path)) continue;
					if (attach.has(path)) continue;
					if (app.backgroundImageId && !solidOnly.has(path)) continue;
					const hex = pool[Math.floor(Math.random() * pool.length)]!;
					const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
					const slot = colorSlotForHex(hex);
					const meta = rockMeta.get(path);
					if (meta) rockMeta.set(path, { ...meta, colorSlot: slot });
					else
						writeRockMeta(path, {
							rockIndex: 0,
							sizeIndex: app.sizeIndex,
							rotation: path.rotation,
							colorSlot: slot
						});
					if (cur && hexEq(cur, hex)) continue;
					path.fillColor = new paper.Color(hex);
					changed = true;
				}
				if (selectedPaths.length) syncSelectionUi(selectedPaths.at(-1) ?? null);
				updateGhost();
			}

			if (changed) commitHistory();
		});
	});

	// Keep the floating tip pinned above the selection as the artboard resizes.
	$effect(() => {
		void stageW;
		void stageH;
		void app.aspect;
		if (!selectedPath) return;
		untrack(() => updateTipPos());
	});

	// Load new uploads, drop removed ones, and re-sync fills. Runs when the
	// image list or the background selection changes, or a load completes.
	$effect(() => {
		void app.images;
		void app.backgroundImageId;
		void imageLoadTick;
		if (!ready) return;
		untrack(() => refreshImages());
	});

	// Generate only when the user clicks Generate (shuffleSeed bumps).
	$effect(() => {
		if (!ready) return;
		const seed = app.shuffleSeed;
		if (seed === seenShuffleSeed) return;
		seenShuffleSeed = seed;
		untrack(() => runShuffle());
	});

	$effect(() => {
		if (!ready) return;
		const version = app.clearVersion;
		if (version === seenClearVersion) return;
		seenClearVersion = version;
		untrack(() => clearCanvas());
	});

	$effect(() => {
		if (!ready) return;
		const version = app.exportVersion;
		if (version === seenExportVersion) return;
		seenExportVersion = version;
		exportTransparent = false;
		showExportDialog = true;
	});

	$effect(() => {
		if (!ready) return;
		const version = app.undoVersion;
		if (version === seenUndoVersion) return;
		seenUndoVersion = version;
		untrack(() => undoHistory());
	});

	$effect(() => {
		if (!ready) return;
		const version = app.redoVersion;
		if (version === seenRedoVersion) return;
		seenRedoVersion = version;
		untrack(() => redoHistory());
	});

	// Drive the native <dialog> from the open flag so it gets focus trapping,
	// Escape-to-close, and a backdrop for free.
	$effect(() => {
		if (!dialogEl) return;
		if (showExportDialog && !dialogEl.open) dialogEl.showModal();
		else if (!showExportDialog && dialogEl.open) dialogEl.close();
	});

	function confirmExport() {
		showExportDialog = false;
		const transparent = canExportTransparent && exportTransparent;
		if (exportFormat === 'svg') exportSvg(transparent);
		else exportPng(transparent);
	}

	function cancelExport() {
		showExportDialog = false;
	}

	function onWheel(event: WheelEvent) {
		const point = new paper.Point(event.offsetX, event.offsetY);
		if (app.imageEditId) {
			const hit = editImageAt(point);
			if (!hit) return;
			event.preventDefault();
			const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
			if (hit.kind === 'bg' && bgCenter) {
				bgScale *= factor;
				bgCenter = point.add(bgCenter.subtract(point).multiply(factor));
				reapplyBg();
			} else if (hit.kind === 'pin') {
				const el = imageEls.get(hit.fill.imageId);
				hit.fill.raster.scale(factor, point);
				coverClamp(hit.fill.raster, hit.fill.clip.bounds);
				if (el) clampPinRaster(hit.fill.raster, hit.fill.clip, el);
				updateEditGhost();
			}
			return;
		}
		if (selectedPaths.length) {
			if (selectionHasLocked()) return;
			event.preventDefault();
			if (rotateSelectedShapes(event.deltaY * 0.25)) {
				syncFillClipsForPaths(selectedPaths);
				updateSelectionVisuals();
				updateTipPos();
				commitRotateHistory();
			}
			return;
		}
		if (app.canvasTool !== 'shape') return;
		event.preventDefault();
		app.rotateBy(event.deltaY * 0.25);
	}

	/** Tip sits above the canvas, so wheel there wouldn't reach `onWheel` otherwise. */
	function onTipWheel(event: WheelEvent) {
		if (!selectedPaths.length || app.imageEditId || selectionHasLocked()) return;
		event.preventDefault();
		event.stopPropagation();
		if (rotateSelectedShapes(event.deltaY * 0.25)) {
			syncFillClipsForPaths(selectedPaths);
			updateSelectionVisuals();
			updateTipPos();
			commitRotateHistory();
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Shift') shiftHeld = true;
		// The native <dialog> traps focus and handles Escape itself; just add
		// Enter as a shortcut to confirm the download.
		if (showExportDialog) {
			if (event.key === 'Enter') {
				event.preventDefault();
				confirmExport();
			}
			return;
		}
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key === 'z') {
			event.preventDefault();
			if (event.shiftKey) app.redo();
			else app.undo();
			return;
		}
		if (app.imageEditId) {
			if (event.key === 'Escape') {
				event.preventDefault();
				cancelImageEditSession();
			}
			return;
		}
		if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPaths.length) {
			event.preventDefault();
			const toErase = [...selectedPaths];
			let erased = false;
			for (const path of toErase) {
				if (eraseShape(path)) erased = true;
			}
			if (erased) commitHistory();
			return;
		}
		if (event.key === 'Escape' && selectedPaths.length) {
			event.preventDefault();
			selectShape(null);
			return;
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			if (selectedPaths.length === 1) setSelectedRock((selectedRockIndex + 1) % ROCK_SVGS.length);
			else if (!selectedPaths.length) app.cycleRock(1);
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (selectedPaths.length === 1) {
				setSelectedRock((selectedRockIndex - 1 + ROCK_SVGS.length) % ROCK_SVGS.length);
			} else if (!selectedPaths.length) app.cycleRock(-1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			if (selectedPaths.length && selectionHasLocked()) return;
			app.advanceColor(1);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (selectedPaths.length && selectionHasLocked()) return;
			app.advanceColor(-1);
		}
	}

	function onKeyup(event: KeyboardEvent) {
		if (event.key === 'Shift') shiftHeld = false;
	}

	/** Outside-canvas moves: skip when the event is on the canvas itself so
	 *  paper.view.onMouseMove remains the sole in-bounds handler. */
	function onWindowPointerMove(event: PointerEvent) {
		if (bgDragIndex !== null) {
			onBgDragMove(event);
			return;
		}
		if (!ready || !canvasEl) return;
		if (event.target === canvasEl) return;
		const point = clientToView(event.clientX, event.clientY);
		if (!point) return;
		handleViewMove(point);
	}

	/** Always end interactions on window up so release outside the canvas
	 *  commits/cancels. Idempotent with paper.view.onMouseUp. */
	function onWindowPointerUp(event: PointerEvent) {
		if (bgDragIndex !== null) {
			onBgDragEnd(event);
			return;
		}
		if (!ready) return;
		handleViewUp();
	}
</script>

<svelte:window
	onkeydown={onKeydown}
	onkeyup={onKeyup}
	onpointermove={onWindowPointerMove}
	onpointerup={onWindowPointerUp}
	onpointercancel={onWindowPointerUp}
/>

<div class="wrap" class:image-editing={!!app.imageEditId} bind:clientWidth={stageW} bind:clientHeight={stageH}>
	{#if app.imageEditId}
		<div class="image-edit-dim" aria-hidden="true"></div>
		<div class="image-edit-bar" role="toolbar" aria-label="Image edit controls">
			<button class="image-edit-action" type="button" onclick={maskAllDuringEdit}>Mask all</button>
			<div class="image-edit-confirm">
				<button
					class="image-edit-icon save"
					type="button"
					onclick={saveImageEditSession}
					title="Save image edits"
					aria-label="Save image edits"
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M3.5 8.5l3 3 6-6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				</button>
				<button
					class="image-edit-icon cancel"
					type="button"
					onclick={cancelImageEditSession}
					title="Cancel image edits"
					aria-label="Cancel image edits"
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" />
					</svg>
				</button>
			</div>
		</div>
	{/if}
	<div class="artboard" style:width="{artboard.w}px" style:height="{artboard.h}px">
		{#if !app.imageEditId}
			<div class="bg-bar" role="toolbar" aria-label="Canvas background">
				<button
					class="bg-dice"
					type="button"
					onclick={rollBgColors}
					title="Shuffle palette order"
					aria-label="Shuffle palette order"
				>
					<svg bind:this={bgDiceSvg} viewBox="0 0 16 16" aria-hidden="true">
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
				{#each orderedPalettes as palette (palette.id)}
					{@const expanded = expandedPaletteId === palette.id}
					{@const interactive = expanded && app.activePaletteId === palette.id}
					<div
						class="palette-item"
						animate:flip={{ duration: PALETTE_FLIP_MS, easing: cubicOut }}
					>
						<!-- tabindex is only set when role=button (condensed) -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							class={['palette-strip', { expanded, condensed: !expanded }]}
							style:--palette-morph={PALETTE_EASE}
							style:--palette-morph-ms="{PALETTE_MORPH_MS}ms"
							role={expanded ? 'group' : 'button'}
							tabindex={expanded ? undefined : 0}
							title={expanded ? undefined : `${palette.name} palette`}
							aria-label={expanded ? `${palette.name} palette` : `Select ${palette.name} palette`}
							{@attach trackPaletteStrip(palette.id)}
							onclick={() => {
								if (!expanded) onSelectPalette(palette.id);
							}}
							onkeydown={(e) => {
								if (expanded) return;
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onSelectPalette(palette.id);
								}
							}}
						>
							{#each paletteDisplaySwatches(palette, expanded) as swatch, i (swatch.key)}
								<!-- tabindex is only set when role=button (expanded interactive) -->
								<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
								<div
									class={[
										'bg-slot',
										{
											active: interactive && i === 0,
											dragging: interactive && bgDragIndex === i
										}
									]}
									role={interactive ? 'button' : undefined}
									tabindex={interactive ? 0 : undefined}
									animate:flip={{ duration: interactive ? 320 : 0, easing: cubicOut }}
									title={interactive ? bgSwatchTitle(swatch.hex) : undefined}
									aria-label={interactive ? bgSwatchTitle(swatch.hex) : undefined}
									aria-pressed={interactive
										? isPaperHex(swatch.hex)
											? i === 0
											: swatch.enabled
										: undefined}
									style:z-index={!expanded ? palette.colors.length - i : undefined}
									style:background={interactive && i === 0 && swatch.hex
										? `color-mix(in srgb, ${swatch.hex} 80%, transparent)`
										: undefined}
									onpointerdown={(e) => {
										if (!interactive) return;
										onBgSlotPointerDown(e, i);
									}}
									onkeydown={(e) => {
										if (!interactive) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											toggleBgSwatchAndRemap(i);
										}
									}}
								>
									<span
										class={[
											'bg-dot',
											{
												on: interactive ? swatch.enabled : false,
												'is-paper': interactive && isPaperHex(swatch.hex),
												pale: !expanded
											}
										]}
										style:background={expanded
											? (swatch.hex ?? undefined)
											: `color-mix(in srgb, ${swatch.hex ?? '#fff'} 42%, white)`}
									></span>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
		<canvas
			bind:this={canvasEl}
			class:transparent-bg={app.canvasBg === null}
			style:width="{artboard.w}px"
			style:height="{artboard.h}px"
			style:background={app.canvasBg ?? '#FFFFFF'}
			onwheel={onWheel}
		></canvas>
	</div>
</div>

{#if tipAnchor && selectedPaths.length && !app.imageEditId && !draggingShape && !draggingMarquee}
	<div
		class={['sel-tip', { shake: tipShake }]}
		style:left={tipPos ? `${tipPos.left}px` : '-9999px'}
		style:top={tipPos ? `${tipPos.top}px` : '0'}
		style:visibility={tipPos ? 'visible' : 'hidden'}
		role="toolbar"
		tabindex="-1"
		aria-label="Selected rock"
		{@attach clampTip}
		onpointerdown={(e) => e.stopPropagation()}
		onwheel={onTipWheel}
	>
		<button
			class={['sel-cycle', 'lock', { on: selectedLocked }]}
			onclick={toggleSelectedLock}
			title={selectedLocked ? 'Unlock' : 'Lock through generate'}
			aria-label={selectedLocked ? 'Unlock rock' : 'Lock rock through generate'}
			aria-pressed={selectedLocked}
		>
			{#if selectedLocked}
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M5 7V5.5a3 3 0 0 1 6 0V7"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/>
					<rect
						x="3.5"
						y="7"
						width="9"
						height="7"
						rx="1.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
					/>
					<circle cx="8" cy="10.5" r="1" fill="currentColor" />
				</svg>
			{:else}
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M5 7V5.5a3 3 0 0 1 5.8-1.1"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/>
					<rect
						x="3.5"
						y="7"
						width="9"
						height="7"
						rx="1.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
					/>
					<circle cx="8" cy="10.5" r="1" fill="currentColor" />
				</svg>
			{/if}
		</button>
		{#if !selectedLocked}
			{#if !multiSelected}
				<button
					class="sel-cycle shape"
					onclick={cycleSelectedRock}
					title="Cycle shape"
					aria-label="Cycle shape"
				>
					<img src={ROCK_IMAGE_URLS[selectedRockIndex]} alt="" />
				</button>
				<button
					class="sel-cycle size"
					onclick={cycleSelectedSize}
					title="Cycle size"
					aria-label="Cycle size"
				>
					{ROCK_SIZES[selectedSizeIndex].label}
				</button>
			{/if}
			{#if !multiSelected && selectedMaskSrc}
				<div class="sel-mask-wrap">
					<button
						class="sel-mask-thumb"
						onclick={editSelectedMask}
						title="Edit image mask"
						aria-label="Edit image mask"
					>
						<img src={selectedMaskSrc} alt="" />
					</button>
					<button
						class="sel-mask-remove"
						onclick={releaseSelectedMask}
						title="Release from image mask"
						aria-label="Release from image mask"
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
			{:else}
				<div class="sel-colors">
					{#each app.availableRockColors as color (color.hex)}
						{@const i = rockColorIndex(color.hex)}
						<button
							class={['sel-dot', { on: selectedColorIndex === i }]}
							style:background={color.hex}
							onclick={() => setSelectedColor(i)}
							title={color.name}
							aria-label={color.name}
							aria-pressed={selectedColorIndex === i}
						></button>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
{/if}

<dialog
	class="modal"
	aria-labelledby="export-title"
	{@attach exportDialog}
	onclose={cancelExport}
	onclick={(e) => {
		if (e.target === e.currentTarget) cancelExport();
	}}
>
	<div class="modal-body">
		<h2 id="export-title" class="modal-title">Download</h2>
		<fieldset class="format-field">
			<legend class="format-legend">Format</legend>
			<div class="format-options">
				<label class="format-option">
					<input type="radio" name="export-format" value="png" bind:group={exportFormat} />
					<span>PNG</span>
				</label>
				<label class="format-option">
					<input type="radio" name="export-format" value="svg" bind:group={exportFormat} />
					<span>SVG</span>
				</label>
			</div>
		</fieldset>
		{#if canExportTransparent}
			<label class="export-transparent">
				<input type="checkbox" bind:checked={exportTransparent} />
				<span>Transparent (instead of white)</span>
			</label>
		{/if}
		<div class="modal-actions">
			<button class="modal-btn ghost" onclick={cancelExport}>Cancel</button>
			<button class="modal-btn primary" onclick={confirmExport}>Download</button>
		</div>
	</div>
</dialog>

<style>
	.wrap {
		position: relative;
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.image-edit-dim {
		position: absolute;
		inset: 0;
		background: rgba(16, 26, 49, 0.28);
		pointer-events: none;
		z-index: 1;
	}

	.image-edit-bar {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		background: var(--paper);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 20px rgba(16, 26, 49, 0.16);
		z-index: 3;
	}

	.image-edit-action {
		font: inherit;
		height: 28px;
		padding: 0 10px;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink);
		background: var(--paper);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}

	.image-edit-action:hover {
		border-color: var(--ink);
	}

	.image-edit-confirm {
		display: flex;
		gap: 4px;
	}

	.image-edit-icon {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--paper);
		cursor: pointer;
	}

	.image-edit-icon svg {
		width: 14px;
		height: 14px;
	}

	.image-edit-icon.save {
		color: var(--paper);
		background: var(--ink);
		border-color: var(--ink);
	}

	.image-edit-icon.save:hover {
		opacity: 0.88;
	}

	.image-edit-icon.cancel:hover {
		border-color: #ed4e3d;
		color: #ed4e3d;
	}

	.wrap.image-editing .artboard {
		z-index: 2;
		position: relative;
	}

	.artboard {
		position: relative;
		flex: 0 0 auto;
	}

	.bg-bar {
		position: absolute;
		left: 50%;
		bottom: calc(100% + 12px);
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 0;
		height: 36px;
		border-radius: 999px;
		color: #fff;
		background-color: #fff;
		border: none;
		box-shadow: 0px 4px 12px 0px rgba(0, 0, 0, 0.15);
		z-index: 4;
		pointer-events: auto;
		overflow: visible;
	}

	.bg-dice {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		padding: 0;
		border: none;
		border-radius: 999px;
		background: color-mix(in srgb, var(--paper) 92%, transparent);
		box-shadow: none;
		backdrop-filter: none;
		color: var(--ink);
		cursor: pointer;
		flex: 0 0 auto;
		box-sizing: border-box;
	}

	.bg-dice:hover {
		background: color-mix(in srgb, var(--ink) 8%, var(--paper));
	}

	.bg-dice svg {
		width: 16px;
		height: 16px;
		display: block;
	}

	.palette-item {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		height: 36px;
	}

	.palette-strip {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		height: 36px;
		padding: 5px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--paper) 92%, transparent);
		box-shadow: none;
		overflow: hidden;
		box-sizing: border-box;
		transition: padding var(--palette-morph-ms, 380ms) var(--palette-morph, ease);
	}

	.palette-strip.condensed {
		align-items: center;
		cursor: pointer;
	}

	.palette-strip.condensed:hover {
		background: color-mix(in srgb, var(--ink) 6%, var(--paper));
	}

	.palette-strip.expanded {
		padding: 0;
		align-items: stretch;
		cursor: default;
	}

	.palette-strip .bg-slot {
		transition:
			margin-left var(--palette-morph-ms, 380ms) var(--palette-morph, ease),
			padding var(--palette-morph-ms, 380ms) var(--palette-morph, ease),
			background-color 200ms ease;
	}

	.palette-strip.condensed .bg-slot {
		margin-left: -19px;
		padding: 0;
		height: 24px;
		pointer-events: none;
		cursor: inherit;
	}

	.palette-strip.condensed .bg-slot:first-child {
		margin-left: 0;
	}

	.palette-strip.expanded .bg-slot {
		margin-left: 0;
		padding: 5px 4px;
		height: auto;
		align-self: stretch;
		pointer-events: auto;
	}

	.bg-slot {
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		touch-action: none;
		cursor: grab;
		user-select: none;
		background: transparent;
		box-sizing: border-box;
	}

	.bg-slot.active {
		border-radius: 999px;
	}

	.bg-slot.dragging {
		cursor: grabbing;
		z-index: 1;
	}

	.bg-dot {
		display: block;
		width: 24px;
		height: 24px;
		min-width: 24px;
		min-height: 24px;
		border: 1.5px dashed rgba(16, 26, 49, 0.28);
		border-radius: 50%;
		opacity: 0.4;
		flex: 0 0 auto;
		pointer-events: none;
		box-sizing: border-box;
		transition:
			opacity 200ms ease,
			border-color 200ms ease,
			border-style 200ms ease,
			background-color 380ms var(--palette-morph, ease);
	}

	.bg-dot.pale {
		opacity: 1;
		border-style: solid;
		border: .1px solid rgba(16, 26, 49, 0.28);
	}

	.bg-slot:hover .bg-dot:not(.pale) {
		opacity: 0.65;
	}

	.bg-dot.on {
		opacity: 1;
		border: 1px solid rgba(16, 26, 49, 0.28);
	}

	.bg-slot.active .bg-dot {
		opacity: 1;
		border: 1px solid rgba(16, 26, 49, 0.28);
	}

	.bg-slot:hover .bg-dot.on {
		opacity: 1;
	}

	canvas {
		display: block;
		background: var(--paper);
		border-radius: 4px;
		box-shadow: 0 2px 16px rgba(16, 26, 49, 0.14);
		cursor: default;
	}

	canvas.transparent-bg {
		background-color: #ffffff;
		background-image:
			linear-gradient(45deg, #d7dbe3 25%, transparent 25%),
			linear-gradient(-45deg, #d7dbe3 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, #d7dbe3 75%),
			linear-gradient(-45deg, transparent 75%, #d7dbe3 75%);
		background-size: 16px 16px;
		background-position:
			0 0,
			0 8px,
			8px -8px,
			-8px 0;
	}

	.modal {
		width: 100%;
		max-width: 300px;
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
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
	}

	.modal-title {
		margin: 0;
		font-size: 14px;
		font-weight: 700;
		color: var(--ink);
	}

	.format-field {
		margin: 0;
		padding: 0;
		border: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.format-legend {
		padding: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.format-options {
		display: flex;
		gap: 8px;
	}

	.format-option {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 32px;
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.format-option:has(input:checked) {
		border-color: var(--ink);
		background: rgba(16, 26, 49, 0.06);
	}

	.format-option input {
		margin: 0;
		accent-color: var(--ink);
		cursor: pointer;
	}

	.export-transparent {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		cursor: pointer;
		user-select: none;
	}

	.export-transparent input {
		margin: 0;
		accent-color: var(--ink);
		cursor: pointer;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.modal-btn {
		font: inherit;
		height: 32px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 600;
		border-radius: 4px;
		cursor: pointer;
		transition: transform 120ms ease, opacity 120ms ease, background-color 120ms ease;
	}

	.modal-btn.ghost {
		color: var(--ink);
		background: none;
		border: 1px solid var(--border);
	}

	.modal-btn.ghost:hover {
		border-color: var(--ink);
	}

	.modal-btn.primary {
		color: var(--paper);
		background: var(--ink);
		border: 1px solid var(--ink);
	}

	.modal-btn.primary:hover {
		transform: translateY(-1px);
		opacity: 0.92;
	}

	.sel-tip {
		position: fixed;
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--paper) 94%, transparent);
		border: 1px solid var(--border);
		box-shadow: 0 8px 24px rgba(16, 26, 49, 0.16);
		backdrop-filter: blur(10px);
		pointer-events: auto;
		width: max-content;
	}

	.sel-tip.shake {
		border-color: #ed4e3d;
		box-shadow: 0 8px 24px rgba(237, 78, 61, 0.28);
		animation: tip-shake 420ms ease;
	}

	@keyframes tip-shake {
		0%,
		100% {
			transform: translateX(0);
		}
		20% {
			transform: translateX(-6px);
		}
		40% {
			transform: translateX(6px);
		}
		60% {
			transform: translateX(-4px);
		}
		80% {
			transform: translateX(4px);
		}
	}

	.sel-colors {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0;
	}

	.sel-mask-wrap {
		position: relative;
		padding: 3px;
		margin: -3px;
		flex: 0 0 auto;
	}

	.sel-mask-thumb {
		width: 32px;
		height: 32px;
		padding: 0;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--paper);
		overflow: hidden;
		cursor: pointer;
	}

	.sel-mask-thumb:hover {
		border-color: var(--ink);
	}

	.sel-mask-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		pointer-events: none;
	}

	.sel-mask-remove {
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

	.sel-mask-remove svg {
		width: 8px;
		height: 8px;
	}

	.sel-mask-remove:hover {
		background: #ed4e3d;
	}

	.sel-cycle {
		font: inherit;
		height: 28px;
		min-width: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 8px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--ink);
		cursor: pointer;
		flex: 0 0 auto;
		transition: background-color 100ms ease, border-color 100ms ease;
	}

	.sel-cycle:hover {
		border-color: var(--ink);
		background: color-mix(in srgb, var(--ink) 5%, transparent);
	}

	.sel-cycle.shape {
		padding: 3px;
		width: 28px;
	}

	.sel-cycle.shape img {
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
	}

	.sel-cycle.size {
		font-size: 11px;
		font-weight: 700;
		min-width: 28px;
		padding: 0;
	}

	.sel-cycle.lock {
		width: 28px;
		min-width: 28px;
		padding: 0;
	}

	.sel-cycle.lock svg {
		width: 14px;
		height: 14px;
	}

	.sel-cycle.lock.on {
		border-color: #2f6fed;
		color: #2f6fed;
		background: color-mix(in srgb, #2f6fed 14%, transparent);
	}

	.sel-dot {
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

	.sel-dot.on {
		opacity: 1;
		box-shadow:
			0 0 0 1px var(--paper),
			0 0 0 2px var(--ink);
	}
</style>
