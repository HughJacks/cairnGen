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
		colors: opts.colors.length ? opts.colors : ['#4371DB']
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

/** Centroid of locked (+ already placed) rocks; falls back to canvas center. */
function massAnchor(
	placed: paper.Path[],
	locked: paper.Path[],
	fallback: paper.Point
): paper.Point {
	const mass = allObstacles(placed, locked);
	if (!mass.length) return fallback;
	let x = 0;
	let y = 0;
	for (const p of mass) {
		x += p.position.x;
		y += p.position.y;
	}
	return new paper.Point(x / mass.length, y / mass.length);
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

/** Unit directions to probe when a spawn lands inside the mass. */
function freeDirs(away: paper.Point): paper.Point[] {
	const primary =
		away.length > 1e-3 ? away.normalize() : new paper.Point(1, 0);
	const ortho = new paper.Point(-primary.y, primary.x);
	return [
		primary,
		primary.add(ortho).normalize(),
		primary.subtract(ortho).normalize(),
		ortho,
		ortho.multiply(-1),
		primary.multiply(-1)
	];
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
		// Nudge out of the mass along several rays, then nestle back in.
		const dirs = freeDirs(point.subtract(anchor));
		const maxSteps = locked.length ? 14 : 8;
		let freed = false;
		outer: for (const dir of dirs) {
			for (let step = 1; step <= maxSteps; step++) {
				cand.position = point.add(dir.multiply(step * 14));
				if (!blocked(cand, placed, locked)) {
					freed = true;
					break outer;
				}
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

/**
 * Grow one cohesive mass. With locked rocks, grow around their centroid and
 * keep retrying until we hit the quota (or exhaust a larger attempt budget).
 */
function buildCenteredCluster(
	sourcePaths: paper.Path[],
	placed: paper.Path[],
	locked: paper.Path[],
	pools: Pools,
	count: number,
	bounds: paper.Rectangle,
	rand: () => number
): void {
	const fallback = bounds.center;
	const hasLocked = locked.length > 0;
	let anchor = massAnchor(placed, locked, fallback);

	let seeded = false;
	const seedTries = hasLocked ? 28 : 6;
	for (let i = 0; i < seedTries && !seeded; i++) {
		const seed = randomPiece(rand, pools);
		if (hasLocked) {
			const baseR = clusterRadius(placed, locked, anchor);
			const angle = rand() * Math.PI * 2;
			const radius = baseR + 8 + i * 12 + rand() * 14;
			const pt = anchor.add(
				new paper.Point(Math.cos(angle) * radius, Math.sin(angle) * radius)
			);
			seeded = tryClusterPlace(sourcePaths, placed, locked, seed, pt, bounds, anchor);
		} else {
			seeded = tryClusterPlace(
				sourcePaths,
				placed,
				locked,
				seed,
				fallback,
				bounds,
				fallback
			);
		}
	}
	if (!seeded) return;

	// Quota fill: failed slots don't permanently underfill the composition.
	const ringTries = hasLocked ? 16 : 10;
	const maxAttempts = hasLocked ? count * 8 : count * 3;
	let attempts = 0;
	while (placed.length < count && attempts < maxAttempts) {
		attempts++;
		anchor = massAnchor(placed, locked, fallback);
		const piece = randomPiece(rand, pools);
		const baseR = clusterRadius(placed, locked, anchor);
		let ok = false;
		for (let i = 0; i < ringTries && !ok; i++) {
			piece.rotation = rand() * 360;
			const angle = rand() * Math.PI * 2;
			const radius = baseR + 8 + i * 14 + rand() * 14;
			const pt = anchor.add(
				new paper.Point(Math.cos(angle) * radius, Math.sin(angle) * radius)
			);
			ok = tryClusterPlace(sourcePaths, placed, locked, piece, pt, bounds, anchor);
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
	const hasLocked = locked.length > 0;
	let stackX = baseX;
	let misses = 0;
	const missLimit = hasLocked ? 3 : 1;
	const dropTries = hasLocked ? 14 : 8;
	const xJitter = hasLocked ? 48 : 20;

	for (let d = 0; d < depth; d++) {
		const piece = randomPiece(rand, pools);
		let ok = false;
		for (let i = 0; i < dropTries && !ok; i++) {
			piece.rotation = rand() * 360;
			const cand = makeCandidate(sourcePaths, piece, bounds);
			const x = stackX + (rand() - 0.5) * xJitter;
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
			misses = 0;
		}
		if (!ok) {
			misses++;
			if (misses >= missLimit) break;
			// Locked obstacles often block one layer — nudge sideways and keep going.
			if (hasLocked) stackX += (rand() - 0.5) * 60;
		}
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
	const hasLocked = locked.length > 0;

	if (opts.mode === 'cluster') {
		// One central mass; count scales gently with canvas width.
		const clusters = Math.min(4, Math.max(2, Math.round(bounds.width / 240)));
		let count = 0;
		for (let c = 0; c < clusters; c++) count += 3 + Math.floor(rand() * 5);
		// Locked rocks already occupy space — aim a bit higher so the new
		// ring around them still feels as full as a fresh generate.
		if (hasLocked) count += Math.min(6, 2 + locked.length);
		buildCenteredCluster(sourcePaths, placed, locked, pools, count, bounds, rand);
	} else {
		let stacks = Math.min(4, Math.max(2, Math.round(bounds.width / 200)));
		if (hasLocked) stacks = Math.min(5, stacks + 1);
		const span = bounds.width * (hasLocked ? 0.62 : 0.5);
		const gap = stacks > 1 ? span / (stacks - 1) : 0;
		const startX = bounds.center.x - span / 2;

		for (let s = 0; s < stacks; s++) {
			const depth = (hasLocked ? 5 : 4) + Math.floor(rand() * 4);
			buildStack(sourcePaths, placed, locked, pools, depth, startX + s * gap, bounds, rand);
		}
	}

	return cullOffCanvas(placed, bounds);
}
