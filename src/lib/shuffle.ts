import paper from 'paper';
import { ROCK_SIZES, type Mode } from './state.svelte';
import { maxFreeTranslation, pathOverlapsAny, removeBody, syncBody } from './physics';

export interface ShuffleOptions {
	mode: Mode;
	/** Hex fills to draw from. */
	colors: string[];
	/** Rock indices to draw from. */
	shapes: number[];
	/** One size for every rock in the composition. */
	sizeIndex: number;
	seed: number;
	/** Already-placed rocks (e.g. locked) that new rocks must not overlap. */
	obstacles?: paper.Path[];
}

export interface PieceSpec {
	rockIndex: number;
	sizeIndex: number;
	colorHex: string;
	rotation: number;
}

const ROCK_HEIGHT = 140;
/** Binary-search steps when nestling / dropping (~0.05px resolution). */
const SETTLE_ITERS = 10;

function rng(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

function pick<T>(rand: () => number, arr: T[]): T {
	return arr[Math.floor(rand() * arr.length)];
}

/** Pools to draw each independent rock from, with safe fallbacks. */
interface Pools {
	shapes: number[];
	sizeIndex: number;
	colors: string[];
}

function poolsFrom(opts: ShuffleOptions): Pools {
	return {
		shapes: opts.shapes.length ? opts.shapes : [0],
		sizeIndex: opts.sizeIndex,
		colors: opts.colors.length ? opts.colors : ['#101A31']
	};
}

/** One independently random rock: shape and color are picked from their pools;
 *  size is shared across the whole shuffle. Rotation is (re)assigned per attempt. */
function randomPiece(rand: () => number, pools: Pools): PieceSpec {
	return {
		rockIndex: pick(rand, pools.shapes),
		sizeIndex: pools.sizeIndex,
		colorHex: pick(rand, pools.colors),
		rotation: rand() * 360
	};
}

function sizeScale(sizeIndex: number, w: number, h: number): number {
	return (ROCK_SIZES[sizeIndex].fraction * Math.sqrt(w * h)) / ROCK_HEIGHT;
}

function makeCandidate(
	sourcePaths: paper.Path[],
	spec: PieceSpec,
	bounds: paper.Rectangle
): paper.Path {
	const cand = sourcePaths[spec.rockIndex].clone({ insert: false }) as paper.Path;
	cand.scale(sizeScale(spec.sizeIndex, bounds.width, bounds.height));
	cand.rotate(spec.rotation);
	cand.fillColor = new paper.Color(spec.colorHex);
	cand.data = {
		rockIndex: spec.rockIndex,
		sizeIndex: spec.sizeIndex,
		rotation: spec.rotation
	};
	return cand;
}

/** Collision set = newly placed + locked obstacles. */
function allObstacles(placed: paper.Path[], locked: paper.Path[]) {
	return locked.length ? placed.concat(locked) : placed;
}

/** True when `cand` penetrates any already-committed rock (Matter SAT). */
function blocked(cand: paper.Path, placed: paper.Path[], locked: paper.Path[]): boolean {
	return pathOverlapsAny(cand, allObstacles(placed, locked));
}

/**
 * Pull `cand` toward `target` as far as possible without overlapping obstacles.
 * Settles flush against neighbors (no intentional clearance).
 */
function nestleToward(
	cand: paper.Path,
	target: paper.Point,
	placed: paper.Path[],
	locked: paper.Path[]
) {
	const delta = target.subtract(cand.position);
	if (delta.length < 1e-3) return;
	const t = maxFreeTranslation(cand, delta, allObstacles(placed, locked), SETTLE_ITERS);
	if (t > 1e-4) cand.translate(delta.multiply(t));
}

/**
 * Lower `cand` until it rests on the ground or another rock. Stack rocks may
 * overhang left/right/top; they must not sink below `groundY`.
 */
function dropToRest(
	cand: paper.Path,
	groundY: number,
	placed: paper.Path[],
	locked: paper.Path[]
): boolean {
	const lift = groundY - cand.bounds.bottom;
	const down = new paper.Point(0, lift);
	const t = maxFreeTranslation(cand, down, allObstacles(placed, locked), SETTLE_ITERS);
	if (t > 1e-4) cand.translate(down.multiply(t));
	return !blocked(cand, placed, locked);
}

function commit(placed: paper.Path[], cand: paper.Path) {
	placed.push(cand);
	// Register immediately so later probes reuse the Matter body.
	syncBody(cand);
}

/** Rough radius of the current mass from `anchor` (for spawn rings). */
function clusterRadius(placed: paper.Path[], locked: paper.Path[], anchor: paper.Point): number {
	let r = 0;
	for (const p of allObstacles(placed, locked)) {
		const b = p.bounds;
		const corners = [
			new paper.Point(b.left, b.top),
			new paper.Point(b.right, b.top),
			new paper.Point(b.left, b.bottom),
			new paper.Point(b.right, b.bottom)
		];
		for (const c of corners) r = Math.max(r, c.getDistance(anchor));
	}
	return r;
}

function tryClusterPlace(
	sourcePaths: paper.Path[],
	placed: paper.Path[],
	locked: paper.Path[],
	spec: PieceSpec,
	point: paper.Point,
	bounds: paper.Rectangle,
	anchor: paper.Point
): boolean {
	const cand = makeCandidate(sourcePaths, spec, bounds);
	cand.position = point;
	if (blocked(cand, placed, locked)) {
		// Nudge outward from the mass until free, then nestle back in.
		const away = point.subtract(anchor);
		const dir =
			away.length > 1e-3 ? away.normalize() : new paper.Point(1, 0);
		let freed = false;
		for (let step = 1; step <= 8; step++) {
			cand.position = point.add(dir.multiply(step * 14));
			if (!blocked(cand, placed, locked)) {
				freed = true;
				break;
			}
		}
		if (!freed) {
			cand.remove();
			return false;
		}
	}
	// Pull toward the mass so rocks kiss instead of floating apart.
	const nestleTarget =
		placed.length || locked.length ? anchor : bounds.center;
	nestleToward(cand, nestleTarget, placed, locked);
	if (blocked(cand, placed, locked)) {
		cand.remove();
		return false;
	}
	commit(placed, cand);
	return true;
}

/** Grow one cohesive mass from the canvas center using Matter overlap only.
 *  When locked rocks already occupy the center, seed just outside them. */
function buildCenteredCluster(
	sourcePaths: paper.Path[],
	placed: paper.Path[],
	locked: paper.Path[],
	pools: Pools,
	count: number,
	bounds: paper.Rectangle,
	rand: () => number
): void {
	const center = bounds.center;

	let seeded = false;
	if (locked.length) {
		// Center is occupied — ring-seed around the locked mass.
		for (let i = 0; i < 14 && !seeded; i++) {
			const seed = randomPiece(rand, pools);
			const baseR = clusterRadius(placed, locked, center);
			const angle = rand() * Math.PI * 2;
			const radius = baseR + 8 + i * 14 + rand() * 10;
			const pt = center.add(new paper.Point(Math.cos(angle) * radius, Math.sin(angle) * radius));
			seeded = tryClusterPlace(sourcePaths, placed, locked, seed, pt, bounds, center);
		}
	} else {
		for (let i = 0; i < 6 && !seeded; i++) {
			const seed = randomPiece(rand, pools);
			seeded = tryClusterPlace(sourcePaths, placed, locked, seed, center, bounds, center);
		}
	}
	if (!seeded) return;

	for (let n = 1; n < count; n++) {
		const piece = randomPiece(rand, pools);
		const baseR = clusterRadius(placed, locked, center);
		let ok = false;
		for (let i = 0; i < 10 && !ok; i++) {
			piece.rotation = rand() * 360;
			const angle = rand() * Math.PI * 2;
			// Spawn just outside the current mass, then step further out.
			const radius = baseR + 8 + i * 16 + rand() * 12;
			const pt = center.add(new paper.Point(Math.cos(angle) * radius, Math.sin(angle) * radius));
			ok = tryClusterPlace(sourcePaths, placed, locked, piece, pt, bounds, center);
		}
	}
}

function buildStack(
	sourcePaths: paper.Path[],
	placed: paper.Path[],
	locked: paper.Path[],
	pools: Pools,
	depth: number,
	baseX: number,
	bounds: paper.Rectangle,
	rand: () => number
): void {
	let stackX = baseX;
	for (let d = 0; d < depth; d++) {
		const piece = randomPiece(rand, pools);
		let ok = false;
		for (let i = 0; i < 8 && !ok; i++) {
			piece.rotation = rand() * 360;
			const cand = makeCandidate(sourcePaths, piece, bounds);
			const x = stackX + (rand() - 0.5) * 20;
			// Start above the artboard so drop always has room to search down.
			cand.position = new paper.Point(x, bounds.top - cand.bounds.height);
			if (!dropToRest(cand, bounds.bottom, placed, locked)) {
				cand.remove();
				continue;
			}
			// Keep the column roughly centered on itself.
			const bias = (stackX - cand.position.x) * 0.35;
			if (Math.abs(bias) > 0.5) {
				const slide = new paper.Point(bias, 0);
				const t = maxFreeTranslation(cand, slide, allObstacles(placed, locked), 6);
				if (t > 1e-4) cand.translate(slide.multiply(t));
			}
			if (blocked(cand, placed, locked)) {
				cand.remove();
				continue;
			}
			commit(placed, cand);
			stackX = stackX * 0.7 + cand.position.x * 0.3;
			ok = true;
		}
		if (!ok) break;
	}
}

/** Drop rocks whose bounds lie entirely outside the artboard. */
function cullOffCanvas(placed: paper.Path[], bounds: paper.Rectangle): paper.Path[] {
	const kept: paper.Path[] = [];
	for (const path of placed) {
		if (path.bounds.intersects(bounds)) {
			kept.push(path);
			continue;
		}
		removeBody(path);
		path.remove();
	}
	return kept;
}

/** Generate a full composition; paths are not yet on the project layer. */
export function generateShuffle(
	sourcePaths: paper.Path[],
	bounds: paper.Rectangle,
	opts: ShuffleOptions
): paper.Path[] {
	const rand = rng(opts.seed);
	const pools = poolsFrom(opts);
	const placed: paper.Path[] = [];
	const locked = opts.obstacles ?? [];

	if (opts.mode === 'cluster') {
		// One central mass; count scales gently with canvas width.
		const clusters = Math.min(4, Math.max(2, Math.round(bounds.width / 240)));
		let count = 0;
		for (let c = 0; c < clusters; c++) count += 3 + Math.floor(rand() * 5);
		buildCenteredCluster(sourcePaths, placed, locked, pools, count, bounds, rand);
	} else {
		const stacks = Math.min(4, Math.max(2, Math.round(bounds.width / 200)));
		const span = bounds.width * 0.5;
		const gap = stacks > 1 ? span / (stacks - 1) : 0;
		const startX = bounds.center.x - span / 2;

		for (let s = 0; s < stacks; s++) {
			const depth = 4 + Math.floor(rand() * 4);
			buildStack(sourcePaths, placed, locked, pools, depth, startX + s * gap, bounds, rand);
		}
	}

	return cullOffCanvas(placed, bounds);
}
