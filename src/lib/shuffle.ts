import paper from 'paper';
import { ROCK_SIZES, type Mode } from './state.svelte';
import { resolveSnap, outlineDistance, GROUP_EPS } from './snapping';

export interface ShuffleOptions {
	mode: Mode;
	/** Hex fills to draw from. */
	colors: string[];
	/** Rock indices to draw from. */
	shapes: number[];
	/** One size for every rock in the composition. */
	sizeIndex: number;
	seed: number;
}

export interface PieceSpec {
	rockIndex: number;
	sizeIndex: number;
	colorHex: string;
	rotation: number;
}

const ROCK_HEIGHT = 140;

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

class PlacementContext {
	parent: number[] = [];

	constructor(public placed: paper.Path[] = []) {}

	find(i: number): number {
		while (this.parent[i] !== i) {
			this.parent[i] = this.parent[this.parent[i]];
			i = this.parent[i];
		}
		return i;
	}

	getComponent = (path: paper.Path): paper.Path[] => {
		const idx = this.placed.indexOf(path);
		if (idx === -1) return [path];
		const root = this.find(idx);
		return this.placed.filter((_, j) => this.find(j) === root);
	};

	link(cand: paper.Path) {
		const idx = this.placed.length - 1;
		this.parent.push(idx);
		for (let j = 0; j < idx; j++) {
			if (!this.placed[j].bounds.expand(GROUP_EPS * 4).intersects(cand.bounds)) continue;
			if (outlineDistance(cand, this.placed[j]) <= GROUP_EPS) {
				this.parent[this.find(j)] = this.find(idx);
			}
		}
	}
}

/** Scale/rotate/position a fresh clone and snap it, WITHOUT committing it to the
 *  placement context. Returns the resolved (still uncommitted) path, or null when
 *  the piece can't rest anywhere valid from this point. */
function snapCandidate(
	sourcePaths: paper.Path[],
	ctx: PlacementContext,
	spec: PieceSpec,
	point: paper.Point,
	bounds: paper.Rectangle,
	mode: Mode
): paper.Path | null {
	const cand = sourcePaths[spec.rockIndex].clone({ insert: false }) as paper.Path;
	cand.scale(sizeScale(spec.sizeIndex, bounds.width, bounds.height));
	cand.rotate(spec.rotation);
	cand.position = point;
	const snap = resolveSnap(cand, ctx.placed, bounds, {
		mode,
		getComponent: ctx.getComponent
	});
	if (!snap.valid) {
		cand.remove();
		return null;
	}
	cand.fillColor = new paper.Color(spec.colorHex);
	cand.data = { rockIndex: spec.rockIndex, sizeIndex: spec.sizeIndex };
	return cand;
}

function commit(ctx: PlacementContext, cand: paper.Path) {
	ctx.placed.push(cand);
	ctx.link(cand);
}

function tryPlace(
	sourcePaths: paper.Path[],
	ctx: PlacementContext,
	spec: PieceSpec,
	point: paper.Point,
	bounds: paper.Rectangle,
	mode: Mode
): paper.Path | null {
	const cand = snapCandidate(sourcePaths, ctx, spec, point, bounds, mode);
	if (!cand) return null;
	commit(ctx, cand);
	return cand;
}

/** Add one rock to a cluster by probing from the canvas center outward and
 *  stopping at the first valid resting spot. This keeps the mass central
 *  without evaluating dozens of fully-snapped candidates per rock. */
function placeTowardCenter(
	sourcePaths: paper.Path[],
	ctx: PlacementContext,
	pools: Pools,
	target: paper.Point,
	bounds: paper.Rectangle,
	rand: () => number,
	attempts: number
): paper.Path | null {
	const piece = randomPiece(rand, pools);
	for (let i = 0; i < attempts; i++) {
		piece.rotation = rand() * 360;
		const angle = rand() * Math.PI * 2;
		const radius = i < 4 ? 0 : 16 + (i - 4) * 14 + rand() * 10;
		const pt = target.add(new paper.Point(Math.cos(angle) * radius, Math.sin(angle) * radius));
		const cand = snapCandidate(sourcePaths, ctx, piece, pt, bounds, 'cluster');
		if (!cand) continue;
		commit(ctx, cand);
		return cand;
	}
	return null;
}

/** Build a single cohesive cluster that grows outward from the canvas center,
 *  keeping every rock as close to the middle as the snap rules allow. */
function buildCenteredCluster(
	sourcePaths: paper.Path[],
	ctx: PlacementContext,
	pools: Pools,
	count: number,
	bounds: paper.Rectangle,
	rand: () => number
): void {
	const center = bounds.center;

	// Seed rock: a fresh random piece dropped dead-center to anchor the mass.
	let first: paper.Path | null = null;
	for (let i = 0; i < 12 && !first; i++) {
		const seed = randomPiece(rand, pools);
		first = tryPlace(sourcePaths, ctx, seed, center, bounds, 'cluster');
	}
	if (!first) return;

	for (let i = 1; i < count; i++) {
		placeTowardCenter(sourcePaths, ctx, pools, center, bounds, rand, 14);
	}
}

function buildStack(
	sourcePaths: paper.Path[],
	ctx: PlacementContext,
	pools: Pools,
	depth: number,
	baseX: number,
	bounds: paper.Rectangle,
	rand: () => number
): paper.Path[] {
	const added: paper.Path[] = [];
	for (let d = 0; d < depth; d++) {
		const piece = randomPiece(rand, pools);
		let ok = false;
		for (let i = 0; i < 48; i++) {
			piece.rotation = rand() * 360;
			const x = baseX + (rand() - 0.5) * 24;
			const y = bounds.bottom - 60 - rand() * bounds.height * 0.5;
			if (tryPlace(sourcePaths, ctx, piece, new paper.Point(x, y), bounds, 'stack')) {
				added.push(ctx.placed[ctx.placed.length - 1]);
				ok = true;
				break;
			}
		}
		if (!ok) break;
	}
	return added;
}

/** Generate a full composition; paths are not yet on the project layer. */
export function generateShuffle(
	sourcePaths: paper.Path[],
	bounds: paper.Rectangle,
	opts: ShuffleOptions
): paper.Path[] {
	const rand = rng(opts.seed);
	const pools = poolsFrom(opts);
	const ctx = new PlacementContext();

	if (opts.mode === 'cluster') {
		// Total rock count scaled to the canvas, grown as one mass hugging the
		// center rather than several clusters scattered across the artboard.
		const clusters = Math.min(4, Math.max(2, Math.round(bounds.width / 240)));
		let count = 0;
		for (let c = 0; c < clusters; c++) count += 3 + Math.floor(rand() * 5);
		buildCenteredCluster(sourcePaths, ctx, pools, count, bounds, rand);
	} else {
		const stacks = Math.min(4, Math.max(2, Math.round(bounds.width / 200)));
		// Keep the stacks packed toward the horizontal center (within the middle
		// half of the canvas) instead of spread across the full width.
		const span = bounds.width * 0.5;
		const gap = stacks > 1 ? span / (stacks - 1) : 0;
		const startX = bounds.center.x - span / 2;

		for (let s = 0; s < stacks; s++) {
			// Independent random depth per stack — each is built from its own
			// freshly drawn rocks rather than a shared template.
			const depth = 4 + Math.floor(rand() * 4);
			buildStack(sourcePaths, ctx, pools, depth, startX + s * gap, bounds, rand);
		}
	}

	return ctx.placed;
}
