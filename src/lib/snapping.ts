import paper from 'paper';
import { fillsPenetrate, pathsOverlap } from './physics';

export type Mode = 'cluster' | 'stack';

export interface BalanceInfo {
	/** X of the supporting stack's center of mass. */
	x: number;
	ok: boolean;
	/** Top y of the supporting stack (for drawing the balance line). */
	top: number;
}

/** A contact between a subject outline and another rock (or the ground). */
export interface ContactPoint {
	/** Midpoint between the two outlines (or ground point). Best for markers. */
	point: paper.Point;
	/** Point on the subject path outline. */
	onSubject: paper.Point;
	/** Point on the other rock (or ground). */
	onOther: paper.Point;
	/** The other rock, or null for ground. */
	other: paper.Path | null;
	dist: number;
}

export interface SnapResult {
	valid: boolean;
	position: paper.Point;
	/** All points where the candidate touches rocks (or the ground). */
	contacts: paper.Point[];
	balance: BalanceInfo | null;
}

export interface SnapOptions {
	mode: Mode;
	/** All rocks transitively touching the given one (its stack/cluster). */
	getComponent: (path: paper.Path) => paper.Path[];
	/** When false (manual cluster placement), rocks may rest anywhere that
	 *  doesn't overlap; nearby rocks still snap together. Defaults to true. */
	requireContact?: boolean;
}

/** How close (px) the cursor's rock has to be before it snaps to a target. */
const SNAP_RADIUS = 140;
/** A second target is treated with equal priority when its distance is
 *  within this much of the nearest one. */
const EQUAL_PRIORITY_TOL = 32;
/** Outline distance (px) below which two rocks count as touching. */
const TOUCH_EPS = 2.5;
/** Outline distance used when grouping placed rocks into stacks. */
export const GROUP_EPS = TOUCH_EPS * 2;
/** Binary search iterations (~1/2^10 px is enough for flush contact). */
const SEARCH_ITERS = 10;

// ---------------------------------------------------------------------------
// Outline sampling. Placed rocks never move, so their samples are computed
// once and cached; the candidate's samples are computed once per snap and
// shifted incrementally as it translates (avoiding repeated arc-length walks).
// ---------------------------------------------------------------------------

function computeSamples(path: paper.Path, density: number, minN: number, maxN: number): paper.Point[] {
	const n = Math.round(Math.min(maxN, Math.max(minN, path.length / density)));
	const pts: paper.Point[] = [];
	const len = path.length;
	if (len <= 0 || n <= 0) return pts;
	for (let i = 0; i < n; i++) {
		const pt = path.getPointAt((len * i) / n);
		if (pt) pts.push(pt);
	}
	return pts;
}

const staticSampleCache = new WeakMap<paper.Path, paper.Point[]>();

function getSamples(path: paper.Path): paper.Point[] {
	let s = staticSampleCache.get(path);
	if (!s) {
		s = computeSamples(path, 12, 24, 64);
		staticSampleCache.set(path, s);
	}
	return s;
}

/** Drop cached outline samples after a path's geometry changes (move/reshape). */
export function invalidateSamples(path: paper.Path) {
	staticSampleCache.delete(path);
}

/** Translate a path and keep any cached outline samples in sync (no recompute). */
export function translatePath(path: paper.Path, offset: paper.Point) {
	if (offset.x === 0 && offset.y === 0) return;
	path.translate(offset);
	const snap = staticSampleCache.get(path);
	if (snap) {
		for (let i = 0; i < snap.length; i++) snap[i] = snap[i]!.add(offset);
	}
}

/** Candidate path plus its sample cache, kept in sync through translations. */
class Candidate {
	samples: paper.Point[];

	constructor(public path: paper.Path) {
		this.samples = computeSamples(path, 12, 24, 64);
	}

	translate(offset: paper.Point) {
		translatePath(this.path, offset);
		this.samples = this.samples.map((p) => p.add(offset));
	}
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function overlaps(a: paper.Path, b: paper.Path): boolean {
	return rocksOverlap(a, b);
}

/**
 * Authoritative overlap test: filled regions penetrate, not merely touch.
 * Backed by Matter.js hard-body SAT collision.
 */
export function rocksOverlap(a: paper.Path, b: paper.Path): boolean {
	return pathsOverlap(a, b);
}

interface Pair {
	dist: number;
	onCandidate: paper.Point;
	onTarget: paper.Point;
}

/**
 * Closest pair of points between two irregular outlines: coarse pass over the
 * cached samples of both paths, then two exact curve projections to refine
 * only the winning pair.
 */
function nearestPairFrom(samples: paper.Point[], path: paper.Path, target: paper.Path): Pair {
	const targetSamples = getSamples(target);
	let bestD2 = Infinity;
	let best = samples[0];
	for (const pa of samples) {
		for (const pb of targetSamples) {
			const dx = pa.x - pb.x;
			const dy = pa.y - pb.y;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD2) {
				bestD2 = d2;
				best = pa;
			}
		}
	}
	// Alternating exact projections converge onto the local closest pair.
	let onTarget = target.getNearestPoint(best);
	const onCandidate = path.getNearestPoint(onTarget);
	onTarget = target.getNearestPoint(onCandidate);
	return { dist: onCandidate.getDistance(onTarget), onCandidate, onTarget };
}

/** Minimal outline-to-outline distance between two placed rocks. */
export function outlineDistance(a: paper.Path, b: paper.Path): number {
	return nearestPairFrom(getSamples(a), a, b).dist;
}

function clampToBounds(cand: Candidate, bounds: paper.Rectangle) {
	const b = cand.path.bounds;
	let dx = 0;
	let dy = 0;
	if (b.left < bounds.left) dx = bounds.left - b.left;
	else if (b.right > bounds.right) dx = bounds.right - b.right;
	if (b.top < bounds.top) dy = bounds.top - b.top;
	else if (b.bottom > bounds.bottom) dy = bounds.bottom - b.bottom;
	if (dx !== 0 || dy !== 0) cand.translate(new paper.Point(dx, dy));
}

/** Distance from the candidate's underside to the ground (bottom border). */
function groundDistance(path: paper.Path, bounds: paper.Rectangle): number {
	return bounds.bottom - path.bounds.bottom;
}

/** Outline point that would touch the ground (the lowest sample). */
function groundContactPoint(cand: Candidate): paper.Point {
	return cand.samples.reduce((m, p) => (p.y > m.y ? p : m));
}

/** Test a translated position without permanently moving the path. */
function freeAt(path: paper.Path, offset: paper.Point, obstacles: paper.Path[], bounds: paper.Rectangle): boolean {
	path.translate(offset);
	const ok = bounds.contains(path.bounds) && !obstacles.some((p) => overlaps(path, p));
	path.translate(offset.multiply(-1));
	return ok;
}

/**
 * Largest fraction t of `delta` the candidate can travel while staying free
 * of overlaps. Because the outlines are irregular, moving the full sampled
 * nearest-point delta can dig one edge into another; the binary search backs
 * off to the tangent position.
 */
function maxFreeTranslation(path: paper.Path, delta: paper.Point, obstacles: paper.Path[], bounds: paper.Rectangle): number {
	if (freeAt(path, delta, obstacles, bounds)) return 1;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < SEARCH_ITERS; i++) {
		const mid = (lo + hi) / 2;
		if (freeAt(path, delta.multiply(mid), obstacles, bounds)) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** Push an overlapping candidate out of an obstacle until the outlines separate. */
function pushOut(cand: Candidate, obstacle: paper.Path) {
	let dir = cand.path.position.subtract(obstacle.bounds.center);
	if (dir.length < 1e-3) dir = new paper.Point(0, -1);
	dir = dir.normalize();
	const reach =
		(cand.path.bounds.size.width +
			cand.path.bounds.size.height +
			obstacle.bounds.size.width +
			obstacle.bounds.size.height) /
		2;

	// Smallest push distance that separates the two outlines.
	const wide = obstacle.bounds.expand(reach * 16);
	let lo = 0;
	let hi = reach;
	if (!freeAt(cand.path, dir.multiply(hi), [obstacle], wide)) return;
	for (let i = 0; i < SEARCH_ITERS; i++) {
		const mid = (lo + hi) / 2;
		if (freeAt(cand.path, dir.multiply(mid), [obstacle], wide)) hi = mid;
		else lo = mid;
	}
	cand.translate(dir.multiply(hi));
}

interface Contact {
	point: paper.Point;
	rock: paper.Path | null;
}

function contactMidpoint(onSubject: paper.Point, onOther: paper.Point): paper.Point {
	return onSubject.add(onOther).multiply(0.5);
}

function findContact(cand: Candidate, nearby: paper.Path[], bounds: paper.Rectangle, mode: Mode): Contact | null {
	let best: Pair | null = null;
	let bestRock: paper.Path | null = null;
	for (const p of nearby) {
		if (!p.bounds.expand(TOUCH_EPS * 8).intersects(cand.path.bounds)) continue;
		const pair = nearestPairFrom(cand.samples, cand.path, p);
		if (!best || pair.dist < best.dist) {
			best = pair;
			bestRock = p;
		}
	}
	if (best && best.dist <= TOUCH_EPS) {
		return { point: contactMidpoint(best.onCandidate, best.onTarget), rock: bestRock };
	}
	if (mode === 'stack' && groundDistance(cand.path, bounds) <= TOUCH_EPS) {
		const onSubject = groundContactPoint(cand);
		const onOther = new paper.Point(onSubject.x, bounds.bottom);
		return { point: contactMidpoint(onSubject, onOther), rock: null };
	}
	return null;
}

/** Every contact where the candidate currently touches a rock or the ground. */
function allContactDetails(
	cand: Candidate,
	nearby: paper.Path[],
	bounds: paper.Rectangle,
	mode: Mode,
	touchEps = TOUCH_EPS
): ContactPoint[] {
	const pts: ContactPoint[] = [];
	for (const p of nearby) {
		if (!p.bounds.expand(touchEps * 8).intersects(cand.path.bounds)) continue;
		const pair = nearestPairFrom(cand.samples, cand.path, p);
		if (pair.dist <= touchEps) {
			pts.push({
				point: contactMidpoint(pair.onCandidate, pair.onTarget),
				onSubject: pair.onCandidate,
				onOther: pair.onTarget,
				other: p,
				dist: pair.dist
			});
		}
	}
	if (mode === 'stack' && groundDistance(cand.path, bounds) <= touchEps) {
		const onSubject = groundContactPoint(cand);
		const onOther = new paper.Point(onSubject.x, bounds.bottom);
		pts.push({
			point: contactMidpoint(onSubject, onOther),
			onSubject,
			onOther,
			other: null,
			dist: Math.abs(groundDistance(cand.path, bounds))
		});
	}
	return pts;
}

/** Midpoints of every contact (for snap results / markers). */
function allContacts(
	cand: Candidate,
	nearby: paper.Path[],
	bounds: paper.Rectangle,
	mode: Mode,
	touchEps = TOUCH_EPS
): paper.Point[] {
	return allContactDetails(cand, nearby, bounds, mode, touchEps).map((c) => c.point);
}

function centerOfMass(paths: paper.Path[]): paper.Point {
	let mass = 0;
	let sx = 0;
	let sy = 0;
	for (const p of paths) {
		const a = Math.abs(p.area) || 1;
		mass += a;
		sx += p.position.x * a;
		sy += p.position.y * a;
	}
	return new paper.Point(sx / mass, sy / mass);
}

/**
 * Contacts for a placed (or ghost) path against `others`, using the same
 * outline threshold as grouping by default.
 */
export function collectContacts(
	path: paper.Path,
	others: paper.Path[],
	bounds: paper.Rectangle,
	mode: Mode,
	touchEps = GROUP_EPS
): ContactPoint[] {
	const cand = new Candidate(path);
	return allContactDetails(cand, others, bounds, mode, touchEps);
}

/** Rich contacts for a placed rock (GROUP_EPS, matching stack/cluster grouping). */
export function getShapeContactDetails(
	path: paper.Path,
	placed: paper.Path[],
	bounds: paper.Rectangle,
	mode: Mode
): ContactPoint[] {
	return collectContacts(
		path,
		placed.filter((p) => p !== path),
		bounds,
		mode,
		GROUP_EPS
	);
}

/** Midpoints where a placed rock touches another rock or the ground. */
export function getShapeContacts(
	path: paper.Path,
	placed: paper.Path[],
	bounds: paper.Rectangle,
	mode: Mode
): paper.Point[] {
	return getShapeContactDetails(path, placed, bounds, mode).map((c) => c.point);
}

/** Target outline gap after separating a true fill penetration (px). */
const SETTLE_GAP = 0.15;
const SETTLE_OUTER_ITERS = 10;
const SETTLE_SEARCH_ITERS = 14;

function nearestPairBetween(a: paper.Path, b: paper.Path): Pair {
	return nearestPairFrom(getSamples(a), a, b);
}

/** Separation unit for mover away from other (centers when penetrating). */
function separationDir(mover: paper.Path, other: paper.Path, pair: Pair): paper.Point {
	// When penetrating, nearest-outline points can sit on the wrong side of the
	// seam — prefer centers so the push actually separates the fills.
	if (fillsPenetrate(mover, other)) {
		let dir = mover.position.subtract(other.position);
		if (dir.length < 1e-6) dir = new paper.Point(0, -1);
		return dir.normalize();
	}
	let dir = pair.onCandidate.subtract(pair.onTarget);
	if (dir.length < 1e-6) {
		dir = mover.position.subtract(other.position);
		if (dir.length < 1e-6) dir = new paper.Point(0, -1);
	}
	return dir.normalize();
}

function freeOfPaperPenetration(path: paper.Path, others: paper.Path[]): boolean {
	return !others.some((o) => fillsPenetrate(path, o));
}

/**
 * Push `mover` away from `other` until Paper fills no longer penetrate.
 * Uses visual penetration only — Matter chords must not invent gaps.
 */
function settlePushApart(mover: paper.Path, other: paper.Path) {
	if (!fillsPenetrate(mover, other)) return;
	const pair = nearestPairBetween(mover, other);
	const dir = separationDir(mover, other, pair);
	const reach =
		(mover.bounds.size.width +
			mover.bounds.size.height +
			other.bounds.size.width +
			other.bounds.size.height) /
			2 +
		8;

	translatePath(mover, dir.multiply(reach));
	const clearedFar = !fillsPenetrate(mover, other);
	translatePath(mover, dir.multiply(-reach));
	if (!clearedFar) return;

	let lo = 0;
	let hi = reach;
	for (let i = 0; i < SETTLE_SEARCH_ITERS; i++) {
		const mid = (lo + hi) / 2;
		translatePath(mover, dir.multiply(mid));
		if (fillsPenetrate(mover, other)) lo = mid;
		else hi = mid;
		translatePath(mover, dir.multiply(-mid));
	}
	translatePath(mover, dir.multiply(hi));
}

/**
 * After separating a real penetration, nestle back to a hairline tangent gap
 * without creating new Paper penetrations.
 */
function settlePullTogether(mover: paper.Path, other: paper.Path, others: paper.Path[]) {
	const pair = nearestPairBetween(mover, other);
	if (pair.dist <= SETTLE_GAP) return;
	const delta = pair.onTarget.subtract(pair.onCandidate);
	if (delta.length < 1e-6) return;

	translatePath(mover, delta);
	const okFull = freeOfPaperPenetration(mover, others);
	translatePath(mover, delta.multiply(-1));
	if (okFull) {
		translatePath(mover, delta);
		return;
	}

	let lo = 0;
	let hi = 1;
	for (let i = 0; i < SETTLE_SEARCH_ITERS; i++) {
		const mid = (lo + hi) / 2;
		const step = delta.multiply(mid);
		translatePath(mover, step);
		if (freeOfPaperPenetration(mover, others)) lo = mid;
		else hi = mid;
		translatePath(mover, step.multiply(-1));
	}
	if (lo > 0) translatePath(mover, delta.multiply(lo));
}

/**
 * Export-only fixup: separate pairs whose Paper fills truly penetrate, then
 * nestle those pairs back to a tiny tangent gap. Does not move flush contacts
 * that Matter chords mis-read as overlaps, and does not pull near-but-gapped
 * rocks together. Mutates `paths` in place — callers snapshot/restore.
 */
export function settleContactsForExport(
	paths: paper.Path[],
	_bounds: paper.Rectangle,
	_mode: Mode
): void {
	if (paths.length === 0) return;

	type PairRef = { a: paper.Path; b: paper.Path; bottom: number };
	const pairs: PairRef[] = [];
	for (let i = 0; i < paths.length; i++) {
		for (let j = i + 1; j < paths.length; j++) {
			const a = paths[i]!;
			const b = paths[j]!;
			if (!a.bounds.intersects(b.bounds)) continue;
			if (!fillsPenetrate(a, b)) continue;
			pairs.push({ a, b, bottom: Math.max(a.bounds.bottom, b.bounds.bottom) });
		}
	}
	if (pairs.length === 0) return;

	// Bottom-to-top so lower supports settle before upper rocks.
	pairs.sort((p, q) => q.bottom - p.bottom);

	for (let iter = 0; iter < SETTLE_OUTER_ITERS; iter++) {
		let moved = false;
		const before = paths.map((p) => p.position.clone());

		for (const { a, b } of pairs) {
			if (!fillsPenetrate(a, b)) continue;
			// Prefer moving the higher rock so stacks settle onto supports.
			const mover = a.bounds.bottom < b.bounds.bottom ? a : b;
			const other = mover === a ? b : a;
			const others = paths.filter((p) => p !== mover);

			settlePushApart(mover, other);
			settlePullTogether(mover, other, others);
		}

		for (let i = 0; i < paths.length; i++) {
			if (paths[i]!.position.getDistance(before[i]!) > 1e-4) {
				moved = true;
				break;
			}
		}
		if (!moved) break;
	}
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Move `candidatePath` (already scaled/rotated and positioned at the cursor)
 * to the nearest valid resting spot. The candidate path is mutated in place.
 *
 * Cluster mode: by default rocks must touch another rock (the very first rock
 * is free). With `requireContact: false`, rocks may go anywhere without
 * overlapping; nearby rocks still snap together. Cluster rocks may run off the
 * canvas, and borders are not snap targets.
 *
 * Stack mode: rocks rest on the ground (bottom border) or on top of other
 * rocks and must sit close to the vertical line through the supporting
 * stack's center of mass. They may overflow the left, right, and top edges,
 * but never sink below the ground.
 */
export function resolveSnap(
	candidatePath: paper.Path,
	placed: paper.Path[],
	bounds: paper.Rectangle,
	opts: SnapOptions
): SnapResult {
	const { mode, requireContact = true } = opts;
	const cand = new Candidate(candidatePath);
	// Cluster rocks may overflow the artboard freely. Stack rocks are only
	// constrained by the ground: they may overflow the left, right, and top.
	const travelBounds =
		mode === 'stack'
			? new paper.Rectangle(new paper.Point(-1e9, -1e9), new paper.Point(1e9, bounds.bottom))
			: bounds.expand(1e9);

	if (mode === 'stack') clampToBounds(cand, travelBounds);

	// Everything expensive only ever looks at rocks near the cursor.
	const nearby = placed.filter((p) => p.bounds.expand(SNAP_RADIUS * 2).intersects(candidatePath.bounds));

	// Separate from anything the cursor is hovering inside of.
	for (let i = 0; i < 3; i++) {
		const obstacle = nearby.find((p) => overlaps(candidatePath, p));
		if (!obstacle) break;
		pushOut(cand, obstacle);
		if (mode === 'stack') clampToBounds(cand, travelBounds);
	}
	if (nearby.some((p) => overlaps(candidatePath, p))) {
		return { valid: false, position: candidatePath.position, contacts: [], balance: null };
	}

	// Nearest snap target: a placed rock outline, or the ground in stack mode.
	let bestRock: (Pair & { path: paper.Path }) | null = null;
	for (const p of nearby) {
		const pair = nearestPairFrom(cand.samples, cand.path, p);
		if (pair.dist <= SNAP_RADIUS && (!bestRock || pair.dist < bestRock.dist)) {
			bestRock = { ...pair, path: p };
		}
	}
	const groundDist = mode === 'stack' ? groundDistance(candidatePath, bounds) : Infinity;
	const groundInRange = groundDist <= SNAP_RADIUS;

	if (bestRock && (!groundInRange || bestRock.dist <= groundDist)) {
		// Equal-priority targets: the nearest edge, plus a second edge whose
		// distance (measured from the cursor position) is comparable. Pulling
		// toward all of them at once moves the shape as little as possible
		// from the cursor while settling into single or double contact.
		const byDist = nearby
			.map((p) => ({ p, dist: nearestPairFrom(cand.samples, cand.path, p).dist }))
			.filter((t) => t.dist <= SNAP_RADIUS)
			.sort((a, b) => a.dist - b.dist)
			.slice(0, 2);
		const targets = byDist.filter((t) => t.dist <= byDist[0].dist + EQUAL_PRIORITY_TOL).map((t) => t.p);

		for (let iter = 0; iter < 12; iter++) {
			let delta = new paper.Point(0, 0);
			let open = 0;
			for (const p of targets) {
				const pair = nearestPairFrom(cand.samples, cand.path, p);
				if (pair.dist > TOUCH_EPS / 2) {
					delta = delta.add(pair.onTarget.subtract(pair.onCandidate));
					open++;
				}
			}
			if (open === 0) break;
			// Damp combined pulls so a two-target step cannot overshoot the gap.
			if (open > 1) delta = delta.multiply(0.6);
			const t = maxFreeTranslation(candidatePath, delta, nearby, travelBounds);
			const step = delta.multiply(t);
			if (step.length < 0.1) break;
			cand.translate(step);
		}

		// Safety net: if the relaxation didn't reach contact, finish with a
		// plain snap to the closest edge.
		const closest = nearestPairFrom(cand.samples, cand.path, byDist[0].p);
		if (closest.dist > TOUCH_EPS) {
			const delta = closest.onTarget.subtract(closest.onCandidate);
			const t = maxFreeTranslation(candidatePath, delta, nearby, travelBounds);
			cand.translate(delta.multiply(t));
		}

		if (mode === 'stack') clampToBounds(cand, travelBounds);
	} else if (groundInRange) {
		cand.translate(new paper.Point(0, groundDist));
		if (nearby.some((p) => overlaps(candidatePath, p))) {
			return { valid: false, position: candidatePath.position, contacts: [], balance: null };
		}
	} else if (mode === 'cluster' && !requireContact) {
		// Manual cluster placement: no snap target in range, rest at the cursor.
	} else if (mode === 'cluster' && placed.length === 0) {
		// The first rock of a cluster can go anywhere.
		return { valid: true, position: candidatePath.position, contacts: [], balance: null };
	} else {
		return { valid: false, position: candidatePath.position, contacts: [], balance: null };
	}

	const contact = findContact(cand, nearby, bounds, mode);
	if (!contact && requireContact) {
		return { valid: false, position: candidatePath.position, contacts: [], balance: null };
	}

	// Balance check: when resting on another rock in stack mode, the new rock
	// must sit close to the supporting stack's center-of-mass line and rest on
	// top of it (not stick to its side or underside).
	let balance: BalanceInfo | null = null;
	if (mode === 'stack' && contact?.rock) {
		const component = opts.getComponent(contact.rock);
		const com = centerOfMass(component);
		const tolerance = Math.max(candidatePath.bounds.width * 0.45, 20);
		const top = Math.min(...component.map((p) => p.bounds.top));
		const ok = Math.abs(candidatePath.position.x - com.x) <= tolerance;
		balance = { x: com.x, ok, top };

		const restingOnTop = contact.point.y > candidatePath.position.y;
		if (!ok || !restingOnTop) {
			return { valid: false, position: candidatePath.position, contacts: [], balance };
		}
	}

	// Final guard against the rocks whose bounds still intersect after travel
	// (cheaper than re-testing the whole placed set every snap).
	const finalNearby = placed.filter((p) => p.bounds.expand(4).intersects(candidatePath.bounds));
	if (finalNearby.some((p) => rocksOverlap(candidatePath, p))) {
		return { valid: false, position: candidatePath.position, contacts: [], balance };
	}

	return {
		valid: true,
		position: candidatePath.position,
		contacts: allContacts(cand, nearby, bounds, mode),
		balance
	};
}
