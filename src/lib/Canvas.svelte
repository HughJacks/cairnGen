<script lang="ts">
	import { untrack } from 'svelte';
	import paper from 'paper';
	import { app, ASPECTS } from './state.svelte';
	import { ROCK_SVGS } from './rocks';
	import { resolveSnap, outlineDistance, GROUP_EPS } from './snapping';
	import { generateShuffle } from './shuffle';

	/** Height (in canvas px) of the tallest rock; all rocks share the same scale factor. */
	const ROCK_HEIGHT = 140;
	const STAGE_PADDING = 72;

	let stageW = $state(0);
	let stageH = $state(0);
	let ready = $state(false);
	let canvasEl: HTMLCanvasElement | null = null;
	let seenClearVersion = app.clearVersion;
	let seenExportVersion = app.exportVersion;

	let sourcePaths: paper.Path[] = [];
	let placed: paper.Path[] = [];
	let ghost: paper.Path | null = null;
	let markers: paper.Path[] = [];
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
	interface BgFill {
		group: paper.Group;
		clip: paper.PathItem;
		raster: paper.Raster;
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

	function loadImage(id: string, src: string) {
		const img = new Image();
		img.onload = () => {
			imageEls.set(id, img);
			imageLoadTick++;
		};
		img.src = src;
	}

	/** Grow/shift a raster until it fully covers a rectangle, so a rock's edges
	 *  and the image's corners are never exposed. */
	function coverClamp(raster: paper.Raster, cb: paper.Rectangle) {
		const grow = Math.max(cb.width / raster.bounds.width, cb.height / raster.bounds.height, 1);
		if (grow > 1) raster.scale(grow);
		const b = raster.bounds;
		let dx = 0;
		let dy = 0;
		if (b.left > cb.left) dx = cb.left - b.left;
		else if (b.right < cb.right) dx = cb.right - b.right;
		if (b.top > cb.top) dy = cb.top - b.top;
		else if (b.bottom < cb.bottom) dy = cb.bottom - b.bottom;
		if (dx !== 0 || dy !== 0) raster.position = raster.position.add(new paper.Point(dx, dy));
	}

	function clamp(v: number, lo: number, hi: number): number {
		if (lo > hi) return (lo + hi) / 2;
		return Math.min(Math.max(v, lo), hi);
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

	/** Clamp the background transform so it still covers the unified silhouette,
	 *  then push it to the single background raster (the unified move/pan). */
	function reapplyBg() {
		if (!bgFill || !bgCenter) return;
		const bg = app.backgroundImageId;
		const el = bg ? imageEls.get(bg) : undefined;
		if (!el) return;
		const rect = bgFill.clip.bounds;
		const minScale = Math.max(rect.width / el.naturalWidth, rect.height / el.naturalHeight);
		if (bgScale < minScale) bgScale = minScale;
		const halfW = (el.naturalWidth * bgScale) / 2;
		const halfH = (el.naturalHeight * bgScale) / 2;
		bgCenter = new paper.Point(
			clamp(bgCenter.x, rect.right - halfW, rect.left + halfW),
			clamp(bgCenter.y, rect.bottom - halfH, rect.top + halfH)
		);
		bgFill.raster.scaling = new paper.Size(bgScale, bgScale);
		bgFill.raster.position = bgCenter;
	}

	function addPinFill(path: paper.Path, imageId: string) {
		const el = imageEls.get(imageId);
		if (!el) return;
		const clip = path.clone({ insert: false }) as paper.Path;
		clip.data = {};
		// A rock hidden behind the background clones to visible=false; keep the
		// clip visible so it actually masks the image.
		clip.visible = true;
		const raster = new paper.Raster(el);
		const cover = Math.max(
			path.bounds.width / el.naturalWidth,
			path.bounds.height / el.naturalHeight
		);
		raster.scaling = new paper.Size(cover, cover);
		raster.position = path.bounds.center;
		const group = new paper.Group([clip, raster]);
		group.clipped = true;
		coverClamp(raster, clip.bounds);
		paper.project.activeLayer.addChild(group);
		path.visible = false;
		fills.set(path, { group, clip, raster, imageId });
	}

	function removeFill(path: paper.Path) {
		const fill = fills.get(path);
		if (!fill) return;
		fill.group.remove();
		fills.delete(path);
		path.visible = true;
	}

	function removeBgFill() {
		bgFill?.group.remove();
		bgFill = null;
	}

	function clearFills() {
		for (const path of [...fills.keys()]) removeFill(path);
		removeBgFill();
	}

	/** Merge every un-pinned rock into one silhouette and clip the single
	 *  background image to it — the shapes become one unified mask. */
	function buildBgFill() {
		removeBgFill();
		const bg = app.backgroundImageId;
		const el = bg ? imageEls.get(bg) : undefined;
		if (!el) return;
		const bgPaths = placed.filter((p) => !attach.has(p));
		if (bgPaths.length === 0) return;

		// Boolean ops ignore operands with visible=false (the rocks are hidden
		// behind the background), so unite visible clones instead — otherwise
		// previously placed shapes silently drop out of the merged mask.
		const clones = bgPaths.map((p) => {
			const c = p.clone({ insert: false }) as paper.PathItem;
			c.visible = true;
			return c;
		});
		let union = clones[0];
		for (let i = 1; i < clones.length; i++) {
			const next = union.unite(clones[i], { insert: false });
			union.remove();
			clones[i].remove();
			union = next;
		}
		union.data = {};
		union.visible = true;

		const raster = new paper.Raster(el);
		raster.scaling = new paper.Size(bgScale, bgScale);
		raster.position = bgCenter ?? paper.view.center;
		const group = new paper.Group([union, raster]);
		group.clipped = true;
		paper.project.activeLayer.addChild(group);
		bgFill = { group, clip: union, raster };
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

		// Un-pinned rocks are hidden behind the background union, or show their
		// solid colour when there is no background.
		for (const path of placed) {
			if (fills.has(path)) {
				path.visible = false;
				continue;
			}
			path.visible = !bgFill;
		}
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

	/** Pin the active tray image to a clicked rock (or unpin if already there). */
	function attachActiveImage(path: paper.Path) {
		const id = app.activeImageId;
		if (!id) return;
		if (attach.get(path) === id) {
			attach.delete(path);
		} else {
			// Becoming a per-instance pin means it can't also be the background.
			if (app.backgroundImageId === id) app.backgroundImageId = null;
			// One image lives on one shape: remove it from any previous rock.
			for (const [p, iid] of [...attach]) {
				if (iid === id) attach.delete(p);
			}
			attach.set(path, id);
		}
		syncFills();
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
		const snap = resolveSnap(cand, placed, viewBounds(), { mode: app.mode, getComponent });
		const nearCursor =
			cand.contains(point) || cand.getNearestPoint(point).getDistance(point) <= CURSOR_ATTACH_DIST;
		return { cand, snap, placeable: snap.valid && nearCursor };
	}

	function updateGhost() {
		ghost?.remove();
		for (const m of markers) m.remove();
		balanceLine?.remove();
		ghost = null;
		markers = [];
		balanceLine = null;
		if (!pointer || !ready || app.designMode === 'shuffle') return;

		// With an image selected, hovering a shape will attach the image rather
		// than place a new rock, so don't show the placement ghost there.
		if (app.activeImageId && shapeAt(pointer)) return;

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
			markers.push(m);
		}
	}

	function clearPlaced() {
		clearFills();
		// Pins reference instances that are about to be removed.
		attach.clear();
		for (const p of placed) p.remove();
		placed = [];
		groupParent = [];
		placedArtboard = { w: artboard.w, h: artboard.h };
		app.placedCount = 0;
	}

	function resetOverlay() {
		ghost?.remove();
		for (const m of markers) m.remove();
		balanceLine?.remove();
		ghost = null;
		markers = [];
		balanceLine = null;
	}

	function clearCanvas() {
		clearPlaced();
		resetOverlay();
		updateGhost();
	}

	function exportPng() {
		if (!canvasEl) return;

		const currentWidth = Math.max(Math.round(artboard.w), 1);
		const currentHeight = Math.max(Math.round(artboard.h), 1);
		const MAX_EXPORT_EDGE = 4096;
		const scale = Math.max(1, Math.floor(MAX_EXPORT_EDGE / Math.max(currentWidth, currentHeight)));
		const exportWidth = currentWidth * scale;
		const exportHeight = currentHeight * scale;

		const exportCanvas = document.createElement('canvas');
		exportCanvas.width = exportWidth;
		exportCanvas.height = exportHeight;

		const exportScope = new paper.PaperScope();
		exportScope.setup(exportCanvas);
		exportScope.view.viewSize = new exportScope.Size(exportWidth, exportHeight);
		const cleanupExportScope = () => {
			exportScope.project.clear();
			exportScope.view.remove();
		};

		const renderImageGroup = (clipJSON: string, el: HTMLImageElement, r: paper.Raster) => {
			const clip = exportScope.project.importJSON(clipJSON);
			if (!clip) return;
			const raster = new exportScope.Raster(el);
			raster.scaling = new exportScope.Size(r.scaling.width, r.scaling.height);
			raster.position = new exportScope.Point(r.position.x, r.position.y);
			const group = new exportScope.Group([clip, raster]);
			group.clipped = true;
			exportScope.project.activeLayer.addChild(group);
			group.scale(scale, new exportScope.Point(0, 0));
		};

		for (const path of placed) {
			const fill = fills.get(path);
			const el = fill ? imageEls.get(fill.imageId) : undefined;
			if (fill && el) {
				renderImageGroup(fill.clip.exportJSON(), el, fill.raster);
				continue;
			}
			// Un-pinned rocks are drawn by the unified background group below.
			if (bgFill) continue;
			const imported = exportScope.project.importJSON(path.exportJSON());
			if (!imported) continue;
			// importJSON returns the item without inserting it into the scene
			// graph, so it must be added explicitly or nothing renders.
			exportScope.project.activeLayer.addChild(imported);
			imported.scale(scale, new exportScope.Point(0, 0));
		}

		// The single unified background image, masked by the merged silhouette.
		const bgEl = app.backgroundImageId ? imageEls.get(app.backgroundImageId) : undefined;
		if (bgFill && bgEl) {
			renderImageGroup(bgFill.clip.exportJSON(), bgEl, bgFill.raster);
		}

		exportScope.view.update();

		const output = document.createElement('canvas');
		output.width = exportWidth;
		output.height = exportHeight;
		const context = output.getContext('2d');
		if (!context) {
			cleanupExportScope();
			return;
		}

		context.fillStyle = '#FFFFFF';
		context.fillRect(0, 0, exportWidth, exportHeight);
		// Paper scales the backing store by devicePixelRatio (e.g. 2x on retina),
		// so draw the full source rect scaled to the output to avoid cropping to
		// the top-left on high-DPI displays.
		context.drawImage(
			exportCanvas,
			0,
			0,
			exportCanvas.width,
			exportCanvas.height,
			0,
			0,
			exportWidth,
			exportHeight
		);

		const link = document.createElement('a');
		link.href = output.toDataURL('image/png');
		link.download = `cairn-${app.aspect.replace(':', 'x')}.png`;
		link.click();

		cleanupExportScope();
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
			sizes: app.enabledSizes,
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
	}

	function setup(canvas: HTMLCanvasElement) {
		canvasEl = canvas;
		paper.setup(canvas);

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
		let raf = 0;
		const scheduleGhostUpdate = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				updateGhost();
			});
		};

		paper.view.onMouseMove = (event: paper.MouseEvent) => {
			// While an image drag is active, pan the picture instead of updating
			// the placement ghost. (paper's View emits mousemove even with the
			// button held, so there's no separate drag event to use.) Background
			// images pan as one unified image; pinned images pan per-rock.
			if (imageDrag) {
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
			if (canvasEl) {
				// Grab over a picture; copy where the active image could attach.
				canvasEl.style.cursor = hitAt(event.point)
					? 'grab'
					: app.activeImageId && shapeAt(event.point)
						? 'copy'
						: '';
			}
			if (app.designMode !== 'place') return;
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
			const hit = hitAt(event.point);
			if (hit) imageDrag = { kind: hit.kind, fill: hit.fill, last: event.point };
		};
		paper.view.onMouseUp = () => {
			imageDrag = null;
			if (canvasEl) canvasEl.style.cursor = '';
		};
		paper.view.onClick = (event: paper.MouseEvent) => {
			// A drag that repositioned an image must not also place/attach.
			if (didDragImage) {
				didDragImage = false;
				return;
			}
			// With an image selected, clicking a rock pins the image to it.
			if (app.activeImageId) {
				const hit = shapeAt(event.point);
				if (hit) {
					attachActiveImage(hit);
					return;
				}
			}
			if (app.designMode !== 'place') return;
			placeRock(event.point);
		};

		ready = true;

		return () => {
			ready = false;
			canvasEl = null;
			if (raf) cancelAnimationFrame(raf);
			placed = [];
			groupParent = [];
			fills = new Map();
			attach = new Map();
			imageDrag = null;
			bgCenter = null;
			bgId = null;
			paper.project.clear();
		};
	}

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
		void app.activeImageId;
		updateGhost();
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
		void app.enabledSizes.join(',');
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
		untrack(() => exportPng());
	});

	function onWheel(event: WheelEvent) {
		const point = new paper.Point(event.offsetX, event.offsetY);
		const hit = hitAt(point);
		if (hit) {
			// Resize the image inside its mask, zooming toward the cursor.
			event.preventDefault();
			const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
			if (hit.kind === 'bg' && bgCenter) {
				bgScale *= factor;
				bgCenter = point.add(bgCenter.subtract(point).multiply(factor));
				reapplyBg();
			} else if (hit.kind === 'pin') {
				hit.fill.raster.scale(factor, point);
				coverClamp(hit.fill.raster, hit.fill.clip.bounds);
			}
			return;
		}
		if (app.designMode !== 'place') return;
		event.preventDefault();
		app.rotateBy(event.deltaY * 0.25);
	}

	function onKeydown(event: KeyboardEvent) {
		if (app.designMode !== 'place') return;
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

<div class="wrap" class:shuffle={app.designMode === 'shuffle'} bind:clientWidth={stageW} bind:clientHeight={stageH}>
	<canvas
		style:width="{artboard.w}px"
		style:height="{artboard.h}px"
		onwheel={onWheel}
		{@attach setup}
	></canvas>
</div>

<style>
	.wrap {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	canvas {
		background: var(--paper);
		border-radius: 4px;
		box-shadow: 0 2px 16px rgba(16, 26, 49, 0.14);
		cursor: crosshair;
	}

	.wrap.shuffle canvas {
		cursor: default;
	}
</style>
