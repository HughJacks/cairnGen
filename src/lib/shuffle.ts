import paper from 'paper';
import {
	maxStackCountFor,
	ROCK_SIZES,
	STACK_COUNT_MIN,
	type AspectId,
	type Mode
} from './state.svelte';
import { fillsPenetrate, maxFreeTranslation, pathOverlapsAny } from './physics';

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
	/** How many separate stacks to generate (stack mode only). */
	stackCount?: number;
	/** Artboard aspect — used to clamp stack count to what can actually place. */
	aspect?: AspectId;
}

export interface PieceSpec {
	rockIndex: number;
	sizeIndex: number;
	colorHex: string;
	rotation: number;
}

/** Must match Canvas template normalization (shared AABB width). */
const ROCK_HEIGHT = 140;
/** Binary-search steps when nestling / dropping (~0.05px resolution). */
const SETTLE_ITERS = 10;
/** Max tilt from a cardinal angle for stack rocks (±degrees). */
const STACK_MAX_TILT = 12;
/** Cardinal bases allowed when stacking (flat or upright). */
const STACK_BASE_ANGLES = [0, 90, 180, 270] as const;
/** Oblong rock (assets/rocks/1.svg) — template is upright; horizontal = 90/270. */
const LONG_ROCK_INDEX = 0;
/** Lane packing — keep in sync with `maxStackCountFor` in state.svelte.ts. */
const STACK_SIDE_PAD = 0.15;
const STACK_MIN_SLOT = 0.95;
/** Clear air between stack footprints (in rock-widths). */
const STACK_MIN_GAP = 0.28;
/** Extra AABB clearance when rejecting sibling contact. */
const STACK_SIBLING_CLEARANCE = 0.06;

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

/**
 * Cardinal resting angle with a little tilt.
 * Large + oblong rock: only horizontal (90/270) — upright never fits two on-canvas
 * and used to thrash Matter retries into lag.
 * `preferFlat` sticks other rocks to 0/180 for a reliable large two-stack.
 */
function stackRotation(
	rand: () => number,
	rockIndex: number,
	sizeIndex: number,
	preferFlat = false
): number {
	const isLong = rockIndex === LONG_ROCK_INDEX;
	const isLarge = sizeIndex >= 2;
	let bases: readonly number[];
	if (isLarge && isLong) bases = [90, 270];
	else if (preferFlat) bases = [0, 180];
	else bases = STACK_BASE_ANGLES;
	const base = pick(rand, [...bases]);
	const tilt = (rand() - 0.5) * 2 * STACK_MAX_TILT;
	return (base + tilt + 360) % 360;
}

function sizeScale(sizeIndex: number, _w: number, h: number): number {
	return (ROCK_SIZES[sizeIndex].fraction * h) / ROCK_HEIGHT;
}

/** Approx AABB width after size scale (templates share ROCK_HEIGHT width). */
function approxRockWidth(sizeIndex: number, bounds: paper.Rectangle): number {
	return ROCK_SIZES[sizeIndex].fraction * bounds.height;
}

/**
 * Stack height by size. Small/medium usually taller, but occasionally only two
 * high; large is always two.
 */
function stackDepthForSize(sizeIndex: number, rand: () => number): number {
	// Occasional short cairn for S/M.
	if (sizeIndex <= 1 && rand() < 0.22) return 2;
	if (sizeIndex <= 0) return 5 + Math.floor(rand() * 2); // 5–6
	if (sizeIndex === 1) return 3 + Math.floor(rand() * 2); // 3–4
	return 2;
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

/** Own-cairn rest check: only reject real Paper fill bites (Matter chords often
 *  report flush contact as overlap, which would strand large two-rock stacks). */
function bitesOwn(cand: paper.Path, own: paper.Path[]): boolean {
	return own.some((o) => fillsPenetrate(cand, o));
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
 * Lower `cand` until it rests on the ground or another rock. Must stay on the
 * artboard (no left/right/top overhang past `bounds`).
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

/** True when the rock's AABB sits fully inside the artboard (small pad). */
function fullyOnCanvas(path: paper.Path, bounds: paper.Rectangle, pad = 1): boolean {
	const b = path.bounds;
	return (
		b.left >= bounds.left + pad &&
		b.right <= bounds.right - pad &&
		b.top >= bounds.top + pad &&
		b.bottom <= bounds.bottom + pad
	);
}

/** Slide horizontally (and trim vertical overflow) so the rock sits on-canvas. */
function nudgeOntoCanvas(cand: paper.Path, bounds: paper.Rectangle): boolean {
	const pad = 1;
	const b = cand.bounds;
	if (b.width > bounds.width - 2 * pad || b.height > bounds.height - 2 * pad) return false;
	let dx = 0;
	if (b.left < bounds.left + pad) dx = bounds.left + pad - b.left;
	else if (b.right > bounds.right - pad) dx = bounds.right - pad - b.right;
	let dy = 0;
	if (b.top < bounds.top + pad) dy = bounds.top + pad - b.top;
	if (b.bottom > bounds.bottom + pad) dy = bounds.bottom + pad - b.bottom;
	if (dx || dy) cand.translate(new paper.Point(dx, dy));
	return fullyOnCanvas(cand, bounds, pad);
}

/** Soft lane test: rock center stays in the lane (tiny spill only). */
function centerInLane(path: paper.Path, lane: { left: number; right: number }): boolean {
	const cx = path.bounds.center.x;
	const pad = Math.max(2, (lane.right - lane.left) * 0.08);
	return cx >= lane.left - pad && cx <= lane.right + pad;
}

/** True when `cand` overlaps or sits within `clearance` of any foreign rock. */
function interferesWith(
	cand: paper.Path,
	others: paper.Path[],
	clearance: number
): boolean {
	if (!others.length) return false;
	if (pathOverlapsAny(cand, others)) return true;
	if (clearance <= 0) return false;
	const zone = cand.bounds.expand(clearance);
	return others.some((o) => zone.intersects(o.bounds));
}

function commit(placed: paper.Path[], cand: paper.Path) {
	placed.push(cand);
	// Bodies are registered once after generate mounts the final set — syncing
	// mid-shuffle left orphans when candidates were later culled/replaced.
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
	const primary = away.length > 1e-3 ? away.normalize() : new paper.Point(1, 0);
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
	const nestleTarget = placed.length || locked.length ? anchor : bounds.center;
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

/**
 * Build one simple vertical cairn inside `lane`. Nestles only against its own
 * rocks; `foreign` (sibling stacks / locked) must stay clear — never touch.
 * Large size always aims for two rocks (one cheap flat rebuild if needed).
 */
function buildStack(
	sourcePaths: paper.Path[],
	stackPlaced: paper.Path[],
	foreign: paper.Path[],
	pools: Pools,
	depth: number,
	baseX: number,
	bounds: paper.Rectangle,
	lane: { left: number; right: number },
	rand: () => number,
	siblingClearance: number
): void {
	const isLarge = pools.sizeIndex >= 2;
	const minCount = isLarge ? Math.min(2, depth) : 0;
	let stackX = Math.min(Math.max(baseX, lane.left + 2), lane.right - 2);
	const none: paper.Path[] = [];

	const tryPlace = (preferFlat: boolean, jitterScale: number, lanePad: number): boolean => {
		const piece = randomPiece(rand, pools);
		piece.rotation = stackRotation(rand, piece.rockIndex, piece.sizeIndex, preferFlat);
		const cand = makeCandidate(sourcePaths, piece, bounds);
		const halfW = cand.bounds.width / 2;
		const canvasMin = bounds.left + halfW + 1;
		const canvasMax = bounds.right - halfW - 1;
		if (canvasMin > canvasMax) {
			cand.remove();
			return false;
		}
		// Oblong-horizontal is wider than the lane — keep center near stackX but
		// don't shrink the X range below what the rock actually needs.
		const isLong = piece.rockIndex === LONG_ROCK_INDEX;
		const laneMin = lane.left + halfW * (isLong ? 0.05 : lanePad);
		const laneMax = lane.right - halfW * (isLong ? 0.05 : lanePad);
		let minX = Math.max(canvasMin, Math.min(laneMin, canvasMax));
		let maxX = Math.min(canvasMax, Math.max(laneMax, canvasMin));
		if (minX > maxX || isLong) {
			minX = canvasMin;
			maxX = canvasMax;
		}
		const xJitter = Math.min(14, Math.max(4, (lane.right - lane.left) * 0.14)) * jitterScale;
		const x = Math.min(Math.max(stackX + (rand() - 0.5) * xJitter, minX), maxX);
		cand.position = new paper.Point(x, bounds.top - cand.bounds.height);
		const dropped = dropToRest(cand, bounds.bottom, stackPlaced, none);
		// Matter may still flag flush contact with the rock below — keep the
		// pose when Paper fills only kiss (critical for large two-stacks).
		if (!dropped && (!stackPlaced.length || bitesOwn(cand, stackPlaced))) {
			cand.remove();
			return false;
		}
		const bias = (stackX - cand.position.x) * 0.35;
		if (Math.abs(bias) > 0.5) {
			const slide = new paper.Point(bias, 0);
			const t = maxFreeTranslation(cand, slide, stackPlaced, 6);
			if (t > 1e-4) cand.translate(slide.multiply(t));
		}
		if (!nudgeOntoCanvas(cand, bounds)) {
			cand.remove();
			return false;
		}
		// Long horizontal rocks are meant to spill past the narrow lane; only
		// require the center stay near the stack line.
		const inLane = isLong
			? Math.abs(cand.bounds.center.x - stackX) <= Math.max(halfW * 0.55, lane.right - lane.left)
			: centerInLane(cand, lane);
		if (bitesOwn(cand, stackPlaced) || !inLane) {
			cand.remove();
			return false;
		}
		if (interferesWith(cand, foreign, siblingClearance)) {
			cand.remove();
			return false;
		}
		if (!fullyOnCanvas(cand, bounds)) {
			cand.remove();
			return false;
		}
		commit(stackPlaced, cand);
		stackX = stackX * 0.7 + cand.position.x * 0.3;
		return true;
	};

	const fillTo = (target: number, preferFlat: boolean, triesPerSlot: number, missLimit: number) => {
		let misses = 0;
		while (stackPlaced.length < target && misses < missLimit) {
			let ok = false;
			for (let i = 0; i < triesPerSlot && !ok; i++) {
				ok = tryPlace(preferFlat, preferFlat ? 0.55 : 1, preferFlat ? 0.2 : 0.35);
			}
			if (ok) misses = 0;
			else misses++;
		}
	};

	// Bounded tries — upright oblong attempts used to burn hundreds of Matter probes.
	fillTo(depth, false, isLarge ? 10 : 14, isLarge ? 4 : 3);

	// One flat rebuild if large stalled short of two rocks.
	if (isLarge && stackPlaced.length < minCount) {
		for (const p of stackPlaced) p.remove();
		stackPlaced.length = 0;
		stackX = Math.min(Math.max(baseX, lane.left + 2), lane.right - 2);
		fillTo(minCount, true, 12, 5);
	}
}

/**
 * Place stack lanes independently at random X positions. Only constraint is a
 * minimum gap so footprints don't overlap — leftover canvas stays empty instead
 * of stretching stacks into an even row.
 */
function stackLanes(
	bounds: paper.Rectangle,
	stacks: number,
	rockW: number,
	rand: () => number
): { centerX: number; left: number; right: number }[] {
	const sidePad = rockW * STACK_SIDE_PAD;
	const minSlot = rockW * STACK_MIN_SLOT;
	const minGap = rockW * STACK_MIN_GAP;
	const half = minSlot / 2;
	const innerLeft = bounds.left + sidePad + half;
	const innerRight = bounds.right - sidePad - half;
	const span = Math.max(0, innerRight - innerLeft);
	// Centers must stay this far apart so lanes (+ min gap) don't collide.
	const minCenterDist = minSlot + minGap;

	const laneFor = (centerX: number) => ({
		centerX,
		left: Math.max(bounds.left + 2, centerX - half),
		right: Math.min(bounds.right - 2, centerX + half)
	});

	if (stacks <= 1 || span < 1e-6) {
		const jitter = (rand() - 0.5) * Math.min(rockW * 0.5, span);
		const centerX =
			span < 1e-6
				? bounds.center.x
				: Math.min(Math.max(innerLeft + span * 0.5 + jitter, innerLeft), innerRight);
		return [laneFor(centerX)];
	}

	const centers: number[] = [];
	const tries = stacks * 40;
	for (let t = 0; t < tries && centers.length < stacks; t++) {
		const x = innerLeft + rand() * span;
		if (centers.every((c) => Math.abs(c - x) >= minCenterDist)) {
			centers.push(x);
		}
	}

	// If rejection sampling underfilled (tight fit), fall back to a compact
	// random block with only small irregular gaps — still not full-width.
	if (centers.length < stacks) {
		centers.length = 0;
		const gaps = Array.from({ length: stacks - 1 }, () => minGap + rand() * minGap * 1.8);
		let gapSum = gaps.reduce((a, b) => a + b, 0);
		let block = stacks * minSlot + gapSum;
		const maxBlock = span + minSlot;
		if (block > maxBlock && gapSum > (stacks - 1) * minGap) {
			const shrink = (block - maxBlock) / gapSum;
			for (let i = 0; i < gaps.length; i++) {
				gaps[i] = Math.max(minGap, gaps[i]! * (1 - shrink));
			}
			gapSum = gaps.reduce((a, b) => a + b, 0);
			block = stacks * minSlot + gapSum;
		}
		const slack = Math.max(0, maxBlock - block);
		let x = innerLeft - half + rand() * slack;
		for (let s = 0; s < stacks; s++) {
			const cx = Math.min(Math.max(x + half, innerLeft), innerRight);
			centers.push(cx);
			x = cx + half + (s < stacks - 1 ? gaps[s]! : 0);
		}
	}

	centers.sort((a, b) => a - b);
	return centers.map(laneFor);
}

/** Drop rocks with no outline sample on the artboard. */
function cullOffCanvas(placed: paper.Path[], bounds: paper.Rectangle): paper.Path[] {
	const kept: paper.Path[] = [];
	for (const path of placed) {
		const b = path.bounds;
		let visible = false;
		if (b.width >= 1e-6 && b.height >= 1e-6 && b.intersects(bounds)) {
			const len = path.length;
			if (len <= 0) {
				visible = bounds.contains(b.center);
			} else {
				const n = Math.max(12, Math.min(48, Math.round(len / 10)));
				for (let i = 0; i < n; i++) {
					const pt = path.getPointAt((len * i) / n);
					if (pt && bounds.contains(pt)) {
						visible = true;
						break;
					}
				}
				if (!visible) visible = bounds.contains(path.interiorPoint);
			}
		}
		if (visible) {
			kept.push(path);
			continue;
		}
		path.remove();
	}
	return kept;
}

/** Pixel-bounds variant of max stack count (same packing constants as aspect helper). */
function maxStackCountForBounds(width: number, height: number, sizeIndex: number): number {
	if (height <= 0) return STACK_COUNT_MIN;
	const ratio = width / height;
	const rock = ROCK_SIZES[sizeIndex]?.fraction ?? ROCK_SIZES[1]!.fraction;
	const sidePad = rock * STACK_SIDE_PAD;
	const minSlot = rock * STACK_MIN_SLOT;
	const minGap = rock * STACK_MIN_GAP;
	const usable = ratio - 2 * sidePad;
	if (usable < minSlot * 0.92) return STACK_COUNT_MIN;
	let n = 1;
	while (n < 5) {
		const need = (n + 1) * minSlot + n * minGap;
		if (need > usable + 1e-9) break;
		n++;
	}
	return n;
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
		const rockW = approxRockWidth(pools.sizeIndex, bounds);
		const maxFit = opts.aspect
			? maxStackCountFor(opts.aspect, pools.sizeIndex)
			: maxStackCountForBounds(bounds.width, bounds.height, pools.sizeIndex);
		const requested = opts.stackCount ?? Math.min(3, maxFit);
		const stacks = Math.min(maxFit, Math.max(STACK_COUNT_MIN, Math.round(requested)));

		const lanes = stackLanes(bounds, stacks, rockW, rand);
		// Flat rocks are shorter than wide — allow fuller target depths.
		const maxDepthByHeight = Math.max(
			2,
			Math.floor((bounds.height * 0.9) / Math.max(rockW * 0.48, 1))
		);

		const siblingClearance = rockW * STACK_SIBLING_CLEARANCE;
		for (const lane of lanes) {
			const depth = Math.min(stackDepthForSize(pools.sizeIndex, rand), maxDepthByHeight);
			const stackPlaced: paper.Path[] = [];
			// Foreign = sibling cairns + locked. Own stack nestles; foreign stays clear.
			const foreign = locked.length ? placed.concat(locked) : placed;
			buildStack(
				sourcePaths,
				stackPlaced,
				foreign,
				pools,
				depth,
				lane.centerX,
				bounds,
				lane,
				rand,
				siblingClearance
			);
			for (const p of stackPlaced) placed.push(p);
		}
	}

	return cullOffCanvas(placed, bounds);
}
