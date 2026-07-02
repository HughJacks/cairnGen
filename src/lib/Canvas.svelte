<script lang="ts">
	import { untrack } from 'svelte';
	import paper from 'paper';
	import { app, ASPECTS } from './state.svelte';
	import { ROCK_SVGS } from './rocks';
	import { resolveSnap, outlineDistance, GROUP_EPS } from './snapping';

	/** Height (in canvas px) of the tallest rock; all rocks share the same scale factor. */
	const ROCK_HEIGHT = 140;
	const STAGE_PADDING = 72;

	let stageW = $state(0);
	let stageH = $state(0);
	let ready = $state(false);

	let sourcePaths: paper.Path[] = [];
	let placed: paper.Path[] = [];
	let ghost: paper.Path | null = null;
	let markers: paper.Path[] = [];
	let balanceLine: paper.Path | null = null;
	let pointer: paper.Point | null = null;

	// Union-find over `placed` indices, grouping rocks into touching stacks.
	let groupParent: number[] = [];

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
		if (!pointer || !ready) return;

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

	function drawBalanceLine(balance: { x: number; top: number }) {
		// Fixed height derived from the stack itself, so the line doesn't
		// bounce around as the cursor moves.
		balanceLine = new paper.Path.Line(
			new paper.Point(balance.x, balance.top - 160),
			new paper.Point(balance.x, viewBounds().bottom)
		);
		balanceLine.strokeColor = new paper.Color('#101A31');
		balanceLine.strokeWidth = 1;
		balanceLine.opacity = 0.15;
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

		app.placedCount++;
	}

	function setup(canvas: HTMLCanvasElement) {
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
			pointer = event.point;
			scheduleGhostUpdate();
		};
		paper.view.onMouseLeave = () => {
			pointer = null;
			scheduleGhostUpdate();
		};
		paper.view.onClick = (event: paper.MouseEvent) => {
			placeRock(event.point);
		};

		ready = true;

		return () => {
			ready = false;
			if (raf) cancelAnimationFrame(raf);
			placed = [];
			groupParent = [];
			paper.project.clear();
		};
	}

	/** Re-anchor the placed arrangement to the current artboard without
	 *  changing rock sizes: bottom-center in stack mode, centered in
	 *  cluster mode. */
	function repositionPlaced(w: number, h: number) {
		if (placed.length === 0) return;

		let bounds = placed[0].bounds;
		for (const p of placed) bounds = bounds.unite(p.bounds);

		const anchor = app.mode === 'stack' ? bounds.bottomCenter : bounds.center;
		const target =
			app.mode === 'stack' ? new paper.Point(w / 2, h) : new paper.Point(w / 2, h / 2);

		const delta = target.subtract(anchor);
		for (const p of placed) p.translate(delta);
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
		updateGhost();
	});

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		app.rotateBy(event.deltaY * 0.25);
	}

	function onKeydown(event: KeyboardEvent) {
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

<div class="wrap" bind:clientWidth={stageW} bind:clientHeight={stageH}>
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
</style>
