<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import paper from 'paper';
	import { app, ASPECTS, ROCK_COLORS } from './state.svelte';
	import { ROCK_SVGS } from './rocks';
	import { resolveSnap, getShapeContacts, outlineDistance, GROUP_EPS } from './snapping';
	import { generateShuffle } from './shuffle';

	/** Height (in canvas px) of the tallest rock; all rocks share the same scale factor. */
	const ROCK_HEIGHT = 140;
	const STAGE_PADDING = 72;
	/** Max image zoom as a multiple of the cover scale that fills a mask. */
	const MAX_ZOOM = 4;

	let stageW = $state(0);
	let stageH = $state(0);
	let ready = $state(false);
	let canvasEl: HTMLCanvasElement | null = null;
	let seenClearVersion = app.clearVersion;
	let seenExportVersion = app.exportVersion;
	let seenUndoVersion = app.undoVersion;
	let seenRedoVersion = app.redoVersion;
	let lastDesignMode = app.designMode;
	let imageEditBaseline: CanvasSnapshot | null = null;

	// Download dialog: pick format and a solid white or transparent background before saving.
	let showExportDialog = $state(false);
	type ExportFormat = 'png' | 'svg';
	let exportFormat = $state<ExportFormat>('png');
	let exportTransparent = $state(false);
	let dialogEl = $state<HTMLDialogElement | null>(null);

	function exportDialog(node: HTMLDialogElement) {
		dialogEl = node;
		return () => {
			dialogEl = null;
		};
	}

	let sourcePaths: paper.Path[] = [];
	let placed: paper.Path[] = [];
	let ghost: paper.Path | null = null;
	let ghostMarkers: paper.Path[] = [];
	let contactMarkers: paper.Path[] = [];
	let balanceLine: paper.Path | null = null;
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
		path: paper.Path;
		grabOffset: paper.Point;
		lastValidPathData: string;
	} | null = null;
	let didDragShape = false;
	let selectedPath: paper.Path | null = null;
	let selectionOutline: paper.Path | null = null;
	let ghostRaf = 0;

	// --- Undo / redo ---------------------------------------------------------
	interface PinTransform {
		imageId: string;
		scaleX: number;
		scaleY: number;
		x: number;
		y: number;
	}

	interface CanvasSnapshot {
		rocks: { pathData: string; fillColor: string }[];
		attach: [number, string][];
		pins: [number, PinTransform][];
		backgroundImageId: string | null;
		bgScale: number;
		bgCenter: { x: number; y: number } | null;
		placedArtboard: { w: number; h: number };
	}

	let historyRecording = true;
	let historyStack: CanvasSnapshot[] = [];
	let historyIndex = -1;

	function captureSnapshot(): CanvasSnapshot {
		return {
			rocks: placed.map((p) => ({
				pathData: p.pathData,
				fillColor: (p.fillColor as paper.Color | null)?.toCSS(true) ?? app.nextColor.hex
			})),
			attach: placed.flatMap((p, i) => {
				const id = attach.get(p);
				return id ? ([[i, id]] as [number, string][]) : [];
			}),
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
		clearFills();
		for (const p of placed) p.remove();
		placed = [];
		groupParent = [];
		attach.clear();

		for (const rock of snap.rocks) {
			const path = new paper.Path({ insert: false });
			path.pathData = rock.pathData;
			path.fillColor = new paper.Color(rock.fillColor);
			paper.project.activeLayer.addChild(path);
			placed.push(path);
		}

		recomputeGroups();
		placedArtboard = { ...snap.placedArtboard };

		for (const [i, imageId] of snap.attach) {
			const path = placed[i];
			if (path) attach.set(path, imageId);
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

	function commitHistory() {
		if (!historyRecording || !ready) return;
		const snap = captureSnapshot();
		historyStack = historyStack.slice(0, historyIndex + 1);
		historyStack.push(snap);
		historyIndex++;
		syncHistoryFlags();
	}

	function undoHistory() {
		if (historyIndex <= 0) return;
		historyIndex--;
		historyRecording = false;
		restoreSnapshot(historyStack[historyIndex]);
		historyRecording = true;
		syncHistoryFlags();
	}

	function redoHistory() {
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

	/** Clip the same background image to each un-pinned rock. CompoundPath and
	 *  boolean-unite masks fail to paint in Paper.js clipped groups, but one
	 *  group per rock (sharing the same pan/zoom) works reliably. */
	function buildBgFill() {
		removeBgFill();
		const bg = app.backgroundImageId;
		const el = bg ? imageEls.get(bg) : undefined;
		if (!el) return;
		const bgPaths = placed.filter((p) => !attach.has(p));
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
			groups.push({ group, clip, raster });
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
		for (const path of placed) {
			const pin = fills.get(path);
			if (pin) {
				path.visible = !pin.raster.loaded;
				continue;
			}
			path.visible = !bgFill || !bgFillReady();
		}
		if (selectedPath && placed.includes(selectedPath)) raiseSelectionVisuals();
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
		const hex = app.nextColor.hex;
		const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
		if (cur === hex) return false;
		path.fillColor = new paper.Color(hex);
		return true;
	}

	function snapOptions() {
		return {
			mode: app.mode,
			getComponent,
			requireContact: app.mode === 'stack'
		} as const;
	}

	/** Resolve a placed rock against every other rock using the same snap rules
	 *  as new placements. Restores `fallbackPathData` when the result is invalid. */
	function resolveShapeSnap(path: paper.Path, fallbackPathData: string): boolean {
		const others = placed.filter((p) => p !== path);
		const snap = resolveSnap(path, others, viewBounds(), snapOptions());
		if (!snap.valid) {
			path.pathData = fallbackPathData;
			return false;
		}
		return true;
	}

	function syncColorFromShape(path: paper.Path) {
		const cur = (path.fillColor as paper.Color | null)?.toCSS(true);
		if (!cur) return;
		const idx = ROCK_COLORS.findIndex((c) => c.hex.toLowerCase() === cur.toLowerCase());
		if (idx >= 0) app.selectColor(idx);
	}

	function selectShape(path: paper.Path | null, syncColor = false) {
		selectedPath = path;
		if (path && syncColor) syncColorFromShape(path);
		updateSelectionVisuals();
		updateGhost();
	}

	function clearContactMarkers() {
		for (const m of contactMarkers) m.remove();
		contactMarkers = [];
	}

	function drawContactMarkers(contacts: paper.Point[]) {
		clearContactMarkers();
		for (const contact of contacts) {
			const m = new paper.Path.Circle({ center: contact, radius: 4 });
			m.fillColor = new paper.Color('#101A31');
			paper.project.activeLayer.addChild(m);
			contactMarkers.push(m);
		}
		raiseSelectionVisuals();
	}

	function raiseSelectionVisuals() {
		selectionOutline?.bringToFront();
		for (const m of contactMarkers) m.bringToFront();
	}

	function updateSelectionOutline() {
		selectionOutline?.remove();
		selectionOutline = null;
		if (!selectedPath || !placed.includes(selectedPath)) {
			selectedPath = null;
			return;
		}
		const outline = cloneRockGeometry(selectedPath);
		outline.strokeColor = new paper.Color('#101A31');
		outline.strokeWidth = 1.5;
		outline.dashArray = [5, 4];
		outline.fillColor = null;
		outline.opacity = 0.55;
		paper.project.activeLayer.addChild(outline);
		selectionOutline = outline;
		raiseSelectionVisuals();
	}

	function updateSelectionVisuals() {
		updateSelectionOutline();
		if (!selectedPath) {
			clearContactMarkers();
			return;
		}
		drawContactMarkers(getShapeContacts(selectedPath, placed, viewBounds(), app.mode));
	}

	/** Move a placed rock to follow the cursor, snapping like a new placement. */
	function moveShapeTo(path: paper.Path, point: paper.Point, grabOffset: paper.Point, fallbackPathData: string): boolean {
		path.position = point.add(grabOffset);
		return resolveShapeSnap(path, fallbackPathData);
	}

	/** Rotate a placed rock and settle it with the same snap rules. */
	function rotateShapeWithSnap(path: paper.Path, degrees: number): boolean {
		const before = path.pathData;
		path.rotate(degrees, path.bounds.center);
		return resolveShapeSnap(path, before);
	}

	/** After moving or rotating a rock, rebuild fills and regroup contacts. */
	function finalizeShapeTransform() {
		syncFills();
		updateSelectionVisuals();
		recomputeGroups();
	}

	/** Remove a placed rock and any image fill pinned to it. */
	function eraseShape(path: paper.Path): boolean {
		const idx = placed.indexOf(path);
		if (idx === -1) return false;
		removeFill(path);
		attach.delete(path);
		path.remove();
		placed.splice(idx, 1);
		if (selectedPath === path) selectShape(null);
		recomputeGroups();
		if (app.backgroundImageId) syncFills();
		app.placedCount = placed.length;
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
		const availH = Math.max(stageH - STAGE_PADDING * 2, 0);
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

	/** How far (px) the resolved shape may sit from the cursor and still count
	 *  as the position the user meant. */
	const CURSOR_ATTACH_DIST = 24;

	/** Scaled clone of the active rock, positioned at the cursor and snapped.
	 *  `placeable` is true only when the snap is valid AND the resolved shape
	 *  is still under (or right next to) the cursor. */
	function makeSnappedCandidate(point: paper.Point) {
		const cand = sourcePaths[app.rockIndex].clone({ insert: false }) as paper.Path;
		cand.scale(sizeScale);
		cand.rotate(app.rotation);
		cand.position = point;
		const snap = resolveSnap(cand, placed, viewBounds(), snapOptions());
		const nearCursor =
			cand.contains(point) || cand.getNearestPoint(point).getDistance(point) <= CURSOR_ATTACH_DIST;
		return { cand, snap, placeable: snap.valid && nearCursor };
	}

	function updateGhost() {
		ghost?.remove();
		for (const m of ghostMarkers) m.remove();
		balanceLine?.remove();
		ghost = null;
		ghostMarkers = [];
		balanceLine = null;
		if (!pointer || !ready || app.designMode === 'shuffle' || app.imageEditId || selectedPath) return;

		// Don't show a placement ghost over existing rocks — click to select instead.
		if (shapeAt(pointer)) return;

		const { cand, snap, placeable } = makeSnappedCandidate(pointer);

		// At unplaceable spots, show a faint gray shape following the cursor
		// exactly — clicks do nothing there.
		if (!placeable) {
			cand.remove();
			const hint = sourcePaths[app.rockIndex].clone({ insert: false }) as paper.Path;
			hint.scale(sizeScale);
			hint.rotate(app.rotation);
			hint.position = pointer;
			hint.fillColor = new paper.Color('#101A31');
			hint.opacity = 0.08;
			paper.project.activeLayer.addChild(hint);
			ghost = hint;
			// In stack mode, an off-balance hover near a stack still shows the
			// balance line so it's clear why placement is blocked.
			if (snap.balance && !snap.balance.ok) drawBalanceLine(snap.balance);
			return;
		}

		paper.project.activeLayer.addChild(cand);
		cand.fillColor = new paper.Color(app.nextColor.hex);
		cand.opacity = 0.65;
		ghost = cand;

		if (snap.balance) drawBalanceLine(snap.balance);

		for (const contact of snap.contacts) {
			const m = new paper.Path.Circle({ center: contact, radius: 4 });
			m.fillColor = new paper.Color('#101A31');
			paper.project.activeLayer.addChild(m);
			ghostMarkers.push(m);
		}
	}

	function clearPlaced() {
		clearFills();
		// Pins reference instances that are about to be removed.
		attach.clear();
		for (const p of placed) p.remove();
		placed = [];
		groupParent = [];
		selectShape(null);
		placedArtboard = { w: artboard.w, h: artboard.h };
		app.placedCount = 0;
	}

	function resetOverlay() {
		ghost?.remove();
		for (const m of ghostMarkers) m.remove();
		balanceLine?.remove();
		ghost = null;
		ghostMarkers = [];
		balanceLine = null;
		updateSelectionVisuals();
	}

	function clearCanvas() {
		clearPlaced();
		resetOverlay();
		updateGhost();
		if (app.designMode === 'place') commitHistory();
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

	function exportSvg(transparent = false) {
		const w = Math.max(Math.round(artboard.w), 1);
		const h = Math.max(Math.round(artboard.h), 1);
		const body: string[] = [];
		const clips: string[] = [];
		let clipIdx = 0;

		if (!transparent) {
			body.push(`<rect width="${w}" height="${h}" fill="#FFFFFF"/>`);
		}

		for (const path of placed) {
			const fill = fills.get(path);
			const el = fill ? imageEls.get(fill.imageId) : undefined;
			if (fill && el) {
				const id = `clip-${clipIdx++}`;
				clips.push(`<clipPath id="${id}"><path d="${escapeXml(fill.clip.pathData)}"/></clipPath>`);
				body.push(`<g clip-path="url(#${id})">${rasterSvgImage(el, fill.raster)}</g>`);
				continue;
			}
			if (bgFill) continue;
			const color = path.fillColor as paper.Color | null;
			if (!color) continue;
			body.push(`<path d="${escapeXml(path.pathData)}" fill="${color.toCSS(true)}"/>`);
		}

		const bgEl = app.backgroundImageId ? imageEls.get(app.backgroundImageId) : undefined;
		if (bgFill && bgEl) {
			for (const { clip, raster } of bgFill.groups) {
				const id = `clip-${clipIdx++}`;
				clips.push(`<clipPath id="${id}"><path d="${escapeXml(clip.pathData)}"/></clipPath>`);
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
	}

	function exportPng(transparent = false) {
		if (!canvasEl) return;

		const w = Math.max(Math.round(artboard.w), 1);
		const h = Math.max(Math.round(artboard.h), 1);
		const MAX_EXPORT_EDGE = 4096;
		const scale = Math.max(1, Math.floor(MAX_EXPORT_EDGE / Math.max(w, h)));

		const output = document.createElement('canvas');
		output.width = w * scale;
		output.height = h * scale;
		const ctx = output.getContext('2d');
		if (!ctx) return;

		// Leave the canvas empty for a transparent PNG; otherwise paint white.
		if (!transparent) {
			ctx.fillStyle = '#FFFFFF';
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
	}

	function runShuffle() {
		if (!ready) return;
		clearPlaced();
		resetOverlay();

		const bounds = viewBounds();
		const rocks = generateShuffle(sourcePaths, bounds, {
			mode: app.mode,
			colors: app.enabledColors,
			shapes: app.enabledShapes,
			sizeIndex: app.sizeIndex,
			seed: app.shuffleSeed
		});

		for (const rock of rocks) {
			paper.project.activeLayer.addChild(rock);
			placed.push(rock);
			groupParent.push(placed.length - 1);
		}

		// Rocks were just generated at this canvas size, so anchor here without
		// rescaling; later artboard changes will scale from this baseline.
		placedArtboard = { w: bounds.width, h: bounds.height };
		repositionPlaced(bounds.width, bounds.height);
		app.placedCount = placed.length;
	}

	function drawBalanceLine(balance: { x: number; top: number }) {
		const bounds = viewBounds();
		// Full-height dotted guide, extended well past the top edge.
		const extend = Math.max(bounds.width, bounds.height) * 4;
		balanceLine = new paper.Path.Line(
			new paper.Point(balance.x, bounds.top - extend),
			new paper.Point(balance.x, bounds.bottom)
		);
		balanceLine.strokeColor = new paper.Color('#101A31');
		balanceLine.strokeWidth = 1;
		balanceLine.dashArray = [4, 6];
		balanceLine.opacity = 0.25;
		paper.project.activeLayer.addChild(balanceLine);
	}

	function placeRock(point: paper.Point) {
		const { cand, placeable } = makeSnappedCandidate(point);
		if (!placeable) {
			cand.remove();
			return;
		}
		paper.project.activeLayer.addChild(cand);
		cand.fillColor = new paper.Color(app.nextColor.hex);
		placed.push(cand);

		// Union the new rock with every placed rock it touches.
		const idx = placed.length - 1;
		groupParent.push(idx);
		for (let j = 0; j < idx; j++) {
			if (!placed[j].bounds.expand(GROUP_EPS * 4).intersects(cand.bounds)) continue;
			if (outlineDistance(cand, placed[j]) <= GROUP_EPS) {
				groupParent[findGroup(j)] = findGroup(idx);
			}
		}

		// A background image should immediately show through the new rock; this
		// leaves other rocks' fills (and their pan/zoom) untouched.
		if (app.backgroundImageId) syncFills();

		app.placedCount++;
		commitHistory();
	}

	function setupPaper() {
		if (!canvasEl) return;
		paper.setup(canvasEl);
		(window as unknown as { __paper: typeof paper; __bg: () => unknown }).__paper = paper;
		(window as unknown as { __bg: () => unknown }).__bg = () =>
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
			return path;
		});

		// Apply one shared multiplier so the rocks keep their relative proportions:
		// the tallest rock becomes ROCK_HEIGHT, the rest scale by the same factor.
		const tallest = Math.max(...sourcePaths.map((p) => p.bounds.height));
		const factor = ROCK_HEIGHT / tallest;
		for (const p of sourcePaths) p.scale(factor);

		// Snap resolution is too heavy to run for every mousemove event, so
		// coalesce moves and recompute the ghost at most once per frame.
		const scheduleGhostUpdate = () => {
			if (ghostRaf) return;
			ghostRaf = requestAnimationFrame(() => {
				ghostRaf = 0;
				updateGhost();
			});
		};

		paper.view.onMouseMove = (event: paper.MouseEvent) => {
			// While an image drag is active, pan the picture instead of updating
			// the placement ghost. (paper's View emits mousemove even with the
			// button held, so there's no separate drag event to use.) Background
			// images pan as one unified image; pinned images pan per-rock.
			if (imageDrag) {
				if (!app.imageEditId) {
					imageDrag = null;
					return;
				}
				const delta = event.point.subtract(imageDrag.last);
				imageDrag.last = event.point;
				if (imageDrag.kind === 'bg' && bgCenter) {
					bgCenter = bgCenter.add(delta);
					reapplyBg();
				} else if (imageDrag.kind === 'pin') {
					const f = imageDrag.fill as PinFill;
					f.raster.position = f.raster.position.add(delta);
					coverClamp(f.raster, f.clip.bounds);
				}
				didDragImage = true;
				if (canvasEl) canvasEl.style.cursor = 'grabbing';
				return;
			}
			if (shapeDrag) {
				const { path, grabOffset, lastValidPathData } = shapeDrag;
				if (moveShapeTo(path, event.point, grabOffset, lastValidPathData)) {
					shapeDrag.lastValidPathData = path.pathData;
				}
				updateSelectionVisuals();
				didDragShape = true;
				if (canvasEl) canvasEl.style.cursor = 'grabbing';
				return;
			}
			if (canvasEl) {
				if (app.imageEditId) {
					const shape = shapeAt(event.point);
					const hit = hitAt(event.point);
					canvasEl.style.cursor = hit ? 'grab' : shape ? 'copy' : '';
				} else {
					canvasEl.style.cursor = '';
				}
			}
			if (app.designMode !== 'place' || app.imageEditId) return;
			pointer = event.point;
			scheduleGhostUpdate();
		};
		paper.view.onMouseLeave = () => {
			if (canvasEl) canvasEl.style.cursor = '';
			if (app.designMode !== 'place') return;
			pointer = null;
			scheduleGhostUpdate();
		};
		paper.view.onMouseDown = (event: paper.MouseEvent) => {
			didDragImage = false;
			didDragShape = false;
			if (app.imageEditId) {
				const hit = hitAt(event.point);
				if (hit) imageDrag = { kind: hit.kind, fill: hit.fill, last: event.point };
				return;
			}
			const shape = shapeAt(event.point);
			if (app.designMode === 'place' && shape) {
				selectShape(shape, true);
				shapeDrag = {
					path: shape,
					grabOffset: shape.position.subtract(event.point),
					lastValidPathData: shape.pathData
				};
			}
		};
		paper.view.onMouseUp = () => {
			if (imageDrag && didDragImage && !app.imageEditId) commitHistory();
			if (shapeDrag && didDragShape) {
				finalizeShapeTransform();
				commitHistory();
			}
			imageDrag = null;
			shapeDrag = null;
			if (canvasEl) canvasEl.style.cursor = '';
		};
		paper.view.onClick = (event: paper.MouseEvent) => {
			if (didDragImage || didDragShape) {
				didDragImage = false;
				didDragShape = false;
				return;
			}
			if (app.imageEditId) {
				const shape = shapeAt(event.point);
				if (shape) toggleImageMask(shape);
				return;
			}
			if (app.designMode !== 'place') return;
			const shape = shapeAt(event.point);
			if (shape) {
				selectShape(shape, true);
				return;
			}
			if (selectedPath) {
				selectShape(null);
				return;
			}
			placeRock(event.point);
		};

		ready = true;
		initHistory();
	}

	onMount(() => {
		setupPaper();
		return () => {
			ready = false;
			canvasEl = null;
			if (ghostRaf) cancelAnimationFrame(ghostRaf);
			placed = [];
			groupParent = [];
			fills = new Map();
			attach = new Map();
			imageDrag = null;
			shapeDrag = null;
			selectedPath = null;
			selectionOutline = null;
			bgCenter = null;
			bgId = null;
			paper.project.clear();
		};
	});

	function unitedBounds(): paper.Rectangle {
		let bounds = placed[0].bounds;
		for (const p of placed) bounds = bounds.unite(p.bounds);
		return bounds;
	}

	/** Refit the placed arrangement to the current artboard: scale the whole
	 *  composition so rocks stay proportional to the canvas (using sqrt of area,
	 *  matching how rocks are sized at generation), then re-anchor —
	 *  bottom-center in stack mode, centered in cluster mode. */
	function repositionPlaced(w: number, h: number) {
		if (placed.length === 0) {
			placedArtboard = { w, h };
			return;
		}

		const prevArea = placedArtboard.w * placedArtboard.h;
		if (prevArea > 0 && w > 0 && h > 0) {
			const factor = Math.sqrt((w * h) / prevArea);
			if (Math.abs(factor - 1) > 1e-4) {
				const pivot = unitedBounds().center;
				for (const p of placed) p.scale(factor, pivot);
			}
		}
		placedArtboard = { w, h };

		const bounds = unitedBounds();
		const anchor = app.mode === 'stack' ? bounds.bottomCenter : bounds.center;
		const target =
			app.mode === 'stack' ? new paper.Point(w / 2, h) : new paper.Point(w / 2, h / 2);

		const delta = target.subtract(anchor);
		for (const p of placed) p.translate(delta);

		// Geometry moved/scaled, so fills (separate clip clones + rasters) are
		// stale: rebuild them against the new layout and shared baseline.
		rebuildFills();
		updateSelectionVisuals();
	}

	// Keep the Paper view sized to the computed artboard and refit the
	// placed rocks whenever it changes. Mode is untracked so toggling it
	// doesn't move existing rocks; it only affects the next refit.
	$effect(() => {
		if (!ready) return;
		paper.view.viewSize = new paper.Size(artboard.w, artboard.h);
		untrack(() => repositionPlaced(artboard.w, artboard.h));
	});

	// Rebuild the ghost when the active rock, upcoming color, size, rotation, or mode changes.
	$effect(() => {
		void app.rockIndex;
		void app.colorIndex;
		void sizeScale;
		void app.rotation;
		void app.mode;
		void app.designMode;
		void app.imageEditId;
		updateGhost();
	});

	// Enter image edit: snapshot for cancel and clear shape selection.
	$effect(() => {
		if (!ready) return;
		const id = app.imageEditId;
		if (!id) return;
		untrack(() => {
			imageEditBaseline = captureSnapshot();
			selectShape(null);
			resetOverlay();
		});
	});

	// When a shape is selected, palette changes recolor it.
	$effect(() => {
		const idx = app.colorIndex;
		if (!ready || app.designMode !== 'place' || app.imageEditId || !selectedPath) return;
		untrack(() => {
			void idx;
			if (recolorShape(selectedPath!)) commitHistory();
		});
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

	// Run shuffle when entering shuffle mode, changing cluster/stack, or clicking Shuffle.
	$effect(() => {
		if (!ready) return;
		void app.designMode;
		void app.shuffleSeed;
		void app.mode;
		// Re-run whenever the enabled color/shape/size pools change — track the
		// actual contents, not just the count, so swapping one entry for another
		// (same length) still regenerates.
		void app.enabledColors.join(',');
		void app.enabledShapes.join(',');
		void app.sizeIndex;
		if (app.designMode !== 'shuffle') return;
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
		showExportDialog = true;
	});

	$effect(() => {
		if (!ready || app.designMode !== 'place') return;
		const version = app.undoVersion;
		if (version === seenUndoVersion) return;
		seenUndoVersion = version;
		untrack(() => undoHistory());
	});

	$effect(() => {
		if (!ready || app.designMode !== 'place') return;
		const version = app.redoVersion;
		if (version === seenRedoVersion) return;
		seenRedoVersion = version;
		untrack(() => redoHistory());
	});

	// Fresh undo stack when returning to place mode from shuffle.
	$effect(() => {
		if (!ready) return;
		const mode = app.designMode;
		if (mode === 'place' && lastDesignMode !== 'place') {
			untrack(() => initHistory());
		}
		lastDesignMode = mode;
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
		if (exportFormat === 'svg') exportSvg(exportTransparent);
		else exportPng(exportTransparent);
	}

	function cancelExport() {
		showExportDialog = false;
	}

	function onWheel(event: WheelEvent) {
		const point = new paper.Point(event.offsetX, event.offsetY);
		if (app.imageEditId) {
			const hit = hitAt(point);
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
			}
			return;
		}
		if (app.designMode === 'place' && selectedPath) {
			event.preventDefault();
			if (rotateShapeWithSnap(selectedPath, event.deltaY * 0.25)) {
				finalizeShapeTransform();
				commitHistory();
			}
			return;
		}
		if (app.designMode !== 'place') return;
		event.preventDefault();
		app.rotateBy(event.deltaY * 0.25);
	}

	function onKeydown(event: KeyboardEvent) {
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
		if (mod && event.key === 'z' && app.designMode === 'place') {
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
		if (app.designMode !== 'place') return;
		if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPath) {
			event.preventDefault();
			if (eraseShape(selectedPath)) commitHistory();
			return;
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			app.cycleRock(1);
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			app.cycleRock(-1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			app.advanceColor(1);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			app.advanceColor(-1);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="wrap" class:shuffle={app.designMode === 'shuffle'} class:image-editing={!!app.imageEditId} bind:clientWidth={stageW} bind:clientHeight={stageH}>
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
	<canvas
		bind:this={canvasEl}
		style:width="{artboard.w}px"
		style:height="{artboard.h}px"
		onwheel={onWheel}
	></canvas>
</div>

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
		<label class="toggle-row">
			<input type="checkbox" bind:checked={exportTransparent} />
			<span class="toggle-text">
				<span class="toggle-label">Transparent background</span>
				<span class="toggle-hint">Save without the white backdrop</span>
			</span>
		</label>
		<div class="preview" class:transparent={exportTransparent} aria-hidden="true"></div>
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

	.wrap.image-editing canvas {
		z-index: 2;
		position: relative;
	}

	canvas {
		background: var(--paper);
		border-radius: 4px;
		box-shadow: 0 2px 16px rgba(16, 26, 49, 0.14);
		cursor: default;
	}

	.wrap.shuffle canvas {
		cursor: default;
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

	.toggle-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
	}

	.toggle-row input {
		margin: 0;
		margin-top: 2px;
		width: 16px;
		height: 16px;
		accent-color: var(--ink);
		cursor: pointer;
		flex: 0 0 auto;
	}

	.toggle-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.toggle-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.toggle-hint {
		font-size: 11px;
		color: var(--ink);
		opacity: 0.55;
	}

	.preview {
		height: 56px;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: #ffffff;
	}

	.preview.transparent {
		/* Checkerboard signalling transparency. */
		background-color: #ffffff;
		background-image:
			linear-gradient(45deg, #d7dbe3 25%, transparent 25%),
			linear-gradient(-45deg, #d7dbe3 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, #d7dbe3 75%),
			linear-gradient(-45deg, transparent 75%, #d7dbe3 75%);
		background-size: 16px 16px;
		background-position: 0 0, 0 8px, 8px -8px, -8px 0;
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
</style>
