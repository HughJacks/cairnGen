import Matter from 'matter-js';
import decomp from 'poly-decomp';
import paper from 'paper';

const { Engine, World, Bodies, Body, Common, Collision, Vertices } = Matter;

Common.setDecomp(decomp);

const BODY_OPTS: Matter.IChamferableBodyDefinition = {
	isStatic: true,
	restitution: 0,
	friction: 0.9,
	frictionStatic: 1,
	frictionAir: 0.08,
	slop: 0.05
};

const SAMPLE_COUNT = 96;
const MAX_FRAME_TRAVEL = 64;
const SEARCH_ITERS = 12;
/** Tangential slide after a blocked push — less than full cursor follow. */
const SLIDE_GAIN = 0.72;
/** How far past the nestle point to probe for a contact normal. */
const NORMAL_PROBE = 2.5;
/** Outline sample must sit at least this far inside another fill to count as
 *  overlap — keeps flush edge contact free while catching real bites. */
const PAPER_PENETRATE = 1.25;

interface BodyLink {
	body: Matter.Body;
	lastX: number;
	lastY: number;
}

let engine: Matter.Engine | null = null;
const links = new Map<paper.Path, BodyLink>();
let warnedHull = false;

const DEBUG_RING = 400;
const debugEvents: Record<string, unknown>[] = [];
let dragFrame = 0;
let lastDragLogAt = 0;

/** On by default for deploy debugging. Silence with `window.__CAIRN_DEBUG_PHYSICS = false`. */
export function debugPhysicsEnabled(): boolean {
	if (typeof window === 'undefined') return false;
	const flag = (window as unknown as { __CAIRN_DEBUG_PHYSICS?: boolean }).__CAIRN_DEBUG_PHYSICS;
	return flag !== false;
}

/** Single-line raw JSON for easy copy/paste from the hosted console. */
export function debugJson(event: string, data: Record<string, unknown> = {}): void {
	if (!debugPhysicsEnabled()) return;
	const entry: Record<string, unknown> = {
		t: +performance.now().toFixed(2),
		iso: new Date().toISOString(),
		event,
		...data
	};
	debugEvents.push(entry);
	if (debugEvents.length > DEBUG_RING) debugEvents.shift();
	const w = window as unknown as {
		__cairnDebugEvents?: unknown[];
		__cairnLastDebug?: unknown;
	};
	w.__cairnDebugEvents = debugEvents;
	w.__cairnLastDebug = entry;
	console.log(JSON.stringify(entry));
}

/** Dump the recent event ring as one JSON string (also logged). */
export function dumpDebugEvents(): string {
	const payload = JSON.stringify({
		dumpedAt: new Date().toISOString(),
		count: debugEvents.length,
		events: debugEvents
	});
	console.log(payload);
	return payload;
}

export function clearDebugEvents(): void {
	debugEvents.length = 0;
}

function pathDebugId(path: paper.Path, index?: number): string {
	const data = path.data as { rockIndex?: number; sizeIndex?: number; rotation?: number } | undefined;
	const b = path.bounds;
	const parts = [
		index !== undefined ? `#${index}` : null,
		data?.rockIndex !== undefined ? `rock${data.rockIndex}` : null,
		data?.sizeIndex !== undefined ? `sz${data.sizeIndex}` : null,
		`pos(${path.position.x.toFixed(1)},${path.position.y.toFixed(1)})`,
		`bounds(${b.left.toFixed(1)},${b.top.toFixed(1)},${b.width.toFixed(1)}x${b.height.toFixed(1)})`,
		path.visible === false ? 'hiddenPath' : null
	];
	return parts.filter(Boolean).join(' ');
}

/** Snapshot Matter links vs placed rocks for phantom-collision debugging. */
export function debugPhysicsSnapshot(
	label: string,
	placed: paper.Path[],
	extra?: Record<string, unknown>
): void {
	if (!debugPhysicsEnabled()) return;

	const placedSet = new Set(placed);
	const linkPaths = [...links.keys()];
	const orphans = linkPaths.filter((p) => !placedSet.has(p));
	const missing = placed.filter((p) => !links.has(p));
	const worldBodies = engine?.world.bodies.length ?? -1;
	const worldComposites = engine?.world.composites.length ?? -1;
	const falseOverlaps = matterFalseOverlaps(placed);

	const rocks = placed.map((path, i) => {
		const link = links.get(path);
		const body = link?.body;
		const dx = body ? body.position.x - path.position.x : null;
		const dy = body ? body.position.y - path.position.y : null;
		return {
			id: pathDebugId(path, i),
			hasBody: !!body,
			bodyPos: body
				? { x: +body.position.x.toFixed(2), y: +body.position.y.toFixed(2) }
				: null,
			pathPos: { x: +path.position.x.toFixed(2), y: +path.position.y.toFixed(2) },
			bodyMinusPath:
				dx !== null && dy !== null
					? { x: +dx.toFixed(2), y: +dy.toFixed(2) }
					: null,
			parts: body?.parts.length ?? 0,
			inProject: !!path.project
		};
	});

	const orphanDetails = orphans.map((path) => ({
		id: pathDebugId(path),
		inProject: !!path.project,
		bodyPos: links.get(path)
			? {
					x: +links.get(path)!.body.position.x.toFixed(2),
					y: +links.get(path)!.body.position.y.toFixed(2)
				}
			: null
	}));

	const mismatch =
		orphans.length > 0 ||
		missing.length > 0 ||
		(worldBodies >= 0 && worldBodies > links.size) ||
		falseOverlaps.length > 0;

	debugJson(`physics:${label}`, {
		...extra,
		counts: {
			placed: placed.length,
			links: links.size,
			worldBodies,
			worldComposites,
			orphans: orphans.length,
			missing: missing.length,
			falseOverlaps: falseOverlaps.length
		},
		matterFalseOverlaps: falseOverlaps,
		rocks,
		orphans: orphanDetails,
		missing: missing.map((p, i) => pathDebugId(p, i)),
		mismatch
	});

	(window as unknown as { __cairnLastPhysicsDebug?: unknown }).__cairnLastPhysicsDebug = {
		label,
		...extra,
		counts: {
			placed: placed.length,
			links: links.size,
			worldBodies,
			worldComposites,
			orphans: orphans.length,
			missing: missing.length
		},
		matterFalseOverlaps: falseOverlaps,
		rocks,
		orphans: orphanDetails,
		missing: missing.map((p, i) => pathDebugId(p, i))
	};
}

/** Called after Paper geometry is translated by physics so snap sample caches stay valid. */
let onPathTranslated: ((path: paper.Path) => void) | null = null;

export function setPathTranslateHook(fn: ((path: paper.Path) => void) | null) {
	onPathTranslated = fn;
}

function sampleOutline(path: paper.Path, count = SAMPLE_COUNT): Matter.Vector[] {
	const len = path.length;
	if (len <= 0) return [];
	const n = Math.max(16, Math.min(count, Math.round(len / 4)));
	const pts: Matter.Vector[] = [];
	for (let i = 0; i < n; i++) {
		const pt = path.getPointAt((len * i) / n);
		if (pt) pts.push({ x: pt.x, y: pt.y });
	}
	return pts;
}

function bodyFromVerts(
	verts: Matter.Vector[],
	isStatic: boolean,
	allowHull: boolean
): Matter.Body | null {
	if (verts.length < 3) return null;

	const centre = Vertices.centre(verts);
	let body: Matter.Body | undefined;
	try {
		body = Bodies.fromVertices(centre.x, centre.y, [verts], { ...BODY_OPTS, isStatic }, true);
	} catch {
		body = undefined;
	}

	if ((!body || body.parts.length === 0) && allowHull) {
		if (!warnedHull) {
			console.warn('[physics] fromVertices failed; using convex hull fallback');
			warnedHull = true;
		}
		const hull = Vertices.hull(verts as Matter.Vertex[]);
		if (hull.length < 3) return null;
		const hc = Vertices.centre(hull);
		body = Bodies.fromVertices(hc.x, hc.y, [hull], { ...BODY_OPTS, isStatic }, true);
	}

	if (!body || body.parts.length === 0) return null;
	Body.setAngle(body, 0);
	Body.setVelocity(body, { x: 0, y: 0 });
	Body.setAngularVelocity(body, 0);
	return body;
}

function buildBodyFromPath(path: paper.Path, isStatic: boolean): Matter.Body | null {
	// Prefer a true decomp of the outline. Hull fallback inflates concave rocks
	// and is especially wrong after rotation (world-space samples change).
	const primary = bodyFromVerts(sampleOutline(path), isStatic, false);
	if (primary) return primary;

	const dense = bodyFromVerts(sampleOutline(path, SAMPLE_COUNT * 2), isStatic, false);
	if (dense) return dense;

	return bodyFromVerts(sampleOutline(path, SAMPLE_COUNT * 2), isStatic, true);
}

function applyBodyToPath(path: paper.Path, link: BodyLink) {
	const dx = link.body.position.x - link.lastX;
	const dy = link.body.position.y - link.lastY;
	if (Math.abs(dx) > 1e-8 || Math.abs(dy) > 1e-8) {
		path.translate(new paper.Point(dx, dy));
		onPathTranslated?.(path);
	}
	link.lastX = link.body.position.x;
	link.lastY = link.body.position.y;
}

/** Create the Matter engine (no renderer, no gravity). */
export function createWorld() {
	destroyWorld();
	engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
	engine.enableSleeping = false;
}

/** Tear down the engine and all body links. */
export function destroyWorld() {
	if (engine) {
		World.clear(engine.world, false);
		Engine.clear(engine);
	}
	engine = null;
	links.clear();
}

/** Register or rebuild a static body from the current Paper path outline. */
export function syncBody(path: paper.Path) {
	if (!engine) return;
	removeBody(path);
	const body = buildBodyFromPath(path, true);
	if (!body) return;
	World.add(engine.world, body);
	links.set(path, { body, lastX: body.position.x, lastY: body.position.y });
}

/** Remove a path's body from the world. */
export function removeBody(path: paper.Path) {
	const link = links.get(path);
	if (!link || !engine) {
		links.delete(path);
		return;
	}
	World.remove(engine.world, link.body);
	links.delete(path);
}

/** Drop every body (paths themselves are left alone). */
export function clearBodies() {
	links.clear();
	if (!engine) return;
	// World.clear drops compound parts too — safer than removing link-by-link.
	World.clear(engine.world, false);
}

/** Replace the physics world so it matches exactly the given paths. */
export function resetBodies(paths: Iterable<paper.Path>) {
	clearBodies();
	for (const path of paths) syncBody(path);
}

/** Pairs whose registered Matter bodies overlap while Paper fills only kiss.
 *  Common after generate — chord samples disagree with flush nestling. */
export function matterFalseOverlaps(paths: paper.Path[]): {
	a: number;
	b: number;
	aId: string;
	bId: string;
}[] {
	const out: { a: number; b: number; aId: string; bId: string }[] = [];
	for (let i = 0; i < paths.length; i++) {
		const a = paths[i]!;
		const la = links.get(a);
		if (!la) continue;
		for (let j = i + 1; j < paths.length; j++) {
			const b = paths[j]!;
			const lb = links.get(b);
			if (!lb) continue;
			if (!bodiesCollide(la.body, lb.body)) continue;
			if (fillsPenetrate(a, b)) continue;
			out.push({ a: i, b: j, aId: pathDebugId(a, i), bId: pathDebugId(b, j) });
		}
	}
	return out;
}

/**
 * Matter-only overlaps (Paper fills just kiss) invent invisible walls.
 * Rebuild denser samples — do NOT nudge Paper geometry (that shoved nestled
 * rocks apart and made drag feel much stickier).
 */
export function reconcileRegisteredOverlaps(paths: paper.Path[]): number {
	const before = matterFalseOverlaps(paths);
	if (!before.length) return 0;
	const touched = new Set<paper.Path>();
	for (const pair of before) {
		const a = paths[pair.a];
		const b = paths[pair.b];
		if (a) touched.add(a);
		if (b) touched.add(b);
	}
	for (const path of touched) rebuildFromPath(path);
	const after = matterFalseOverlaps(paths);
	return Math.max(0, before.length - after.length);
}

/** Drop every body whose path is not in `active` (orphans still block drag). */
export function pruneBodiesExcept(active: Iterable<paper.Path>) {
	const keep = active instanceof Set ? active : new Set(active);
	for (const path of [...links.keys()]) {
		if (!keep.has(path)) removeBody(path);
	}
}

/**
 * After Paper mutates geometry (reshape / pathData restore / rotate), rebuild
 * the Matter body so the outline matches.
 */
export function rebuildFromPath(path: paper.Path) {
	const wasStatic = links.get(path)?.body.isStatic ?? true;
	syncBody(path);
	const link = links.get(path);
	if (link && !wasStatic) {
		Body.setStatic(link.body, false);
		Body.setInertia(link.body, Infinity);
	}
}

/** Move the Matter body by the same delta just applied to the Paper path. */
export function translateBody(path: paper.Path, dx: number, dy: number) {
	const link = links.get(path);
	if (!link || (dx === 0 && dy === 0)) return;
	Body.setPosition(link.body, {
		x: link.body.position.x + dx,
		y: link.body.position.y + dy
	});
	link.lastX = link.body.position.x;
	link.lastY = link.body.position.y;
}

/**
 * Sample current Paper geometry. Overlap probes always rebuild from the path so
 * rotate/place/move agree — registered bodies can lag or differ after rotation
 * (chord samples are orientation-dependent).
 */
function bodyForOverlap(path: paper.Path): Matter.Body | null {
	return buildBodyFromPath(path, true);
}

function bodiesCollide(a: Matter.Body, b: Matter.Body): boolean {
	return !!Collision.collides(a, b)?.collided;
}

/** True when any pair among `paths` penetrates (multi-select rigid rotate). */
function selectionSelfOverlaps(paths: paper.Path[]): boolean {
	for (let i = 0; i < paths.length; i++) {
		for (let j = i + 1; j < paths.length; j++) {
			if (pathsOverlap(paths[i]!, paths[j]!)) return true;
		}
	}
	return false;
}

function groupOverlaps(paths: paper.Path[], obstacles: paper.Path[]): boolean {
	return anyOverlap(paths, obstacles) || (paths.length > 1 && selectionSelfOverlaps(paths));
}

/** True when a sample of `subject`'s outline sits clearly inside `other`'s fill. */
function outlinePenetrates(subject: paper.Path, other: paper.Path): boolean {
	const len = subject.length;
	if (len <= 0) return false;
	const n = Math.max(12, Math.min(48, Math.round(len / 10)));
	for (let i = 0; i < n; i++) {
		const pt = subject.getPointAt((len * i) / n);
		if (!pt || !other.contains(pt)) continue;
		if (other.getNearestPoint(pt).getDistance(pt) > PAPER_PENETRATE) return true;
	}
	return false;
}

/** Paper fill-penetration check. Ignores mere outline kissing. */
function paperPathsOverlap(a: paper.Path, b: paper.Path): boolean {
	if (!a.bounds.intersects(b.bounds)) return false;
	if (a.contains(b.interiorPoint) || b.contains(a.interiorPoint)) return true;
	return outlinePenetrates(a, b) || outlinePenetrates(b, a);
}

/** True when Paper fills visibly penetrate (not Matter chord contact). */
export function fillsPenetrate(a: paper.Path, b: paper.Path): boolean {
	return paperPathsOverlap(a, b);
}

/** True when two path fills penetrate (Matter SAT). Paper is a safety net for
 *  chord-approximation misses — not used to invent clearance gaps. */
export function pathsOverlap(a: paper.Path, b: paper.Path): boolean {
	if (!a.bounds.intersects(b.bounds)) return false;
	const ba = bodyForOverlap(a);
	const bb = bodyForOverlap(b);
	if (!ba || !bb) return paperPathsOverlap(a, b);
	if (bodiesCollide(ba, bb)) return true;
	return paperPathsOverlap(a, b);
}

/**
 * Overlap test that samples both sides from current Paper geometry so
 * placement, drag validation, and rotation share one oracle. Paper fill
 * check only rejects real penetration.
 */
export function pathOverlapsAny(path: paper.Path, others: paper.Path[]): boolean {
	if (others.length === 0) return false;
	const cand = bodyForOverlap(path);
	if (!cand) return others.some((o) => paperPathsOverlap(path, o));

	const cb = path.bounds;
	for (const o of others) {
		if (o === path || !cb.intersects(o.bounds)) continue;
		const ob = bodyForOverlap(o);
		if (!ob) {
			if (paperPathsOverlap(path, o)) return true;
			continue;
		}
		if (bodiesCollide(cand, ob) || paperPathsOverlap(path, o)) return true;
	}
	return false;
}

/**
 * Build the candidate body once, then binary-search the largest free fraction
 * of `delta` against Matter bodies (flush contact). A final Paper check only
 * backs off when the true fill would visibly penetrate.
 */
export function maxFreeTranslation(
	path: paper.Path,
	delta: paper.Point,
	obstacles: paper.Path[],
	iters = 10
): number {
	if (obstacles.length === 0 || delta.length < 1e-8) return 1;

	const cand = buildBodyFromPath(path, true);
	if (!cand) {
		path.translate(delta);
		const free = !pathOverlapsAny(path, obstacles);
		path.translate(delta.multiply(-1));
		if (free) return 1;
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < iters; i++) {
			const mid = (lo + hi) / 2;
			path.translate(delta.multiply(mid));
			if (pathOverlapsAny(path, obstacles)) hi = mid;
			else lo = mid;
			path.translate(delta.multiply(-mid));
		}
		return lo;
	}

	const ox = cand.position.x;
	const oy = cand.position.y;
	const obsBodies: Matter.Body[] = [];
	for (const o of obstacles) {
		// Fresh samples — same oracle as pathOverlapsAny / rotate.
		const b = bodyForOverlap(o);
		if (b) obsBodies.push(b);
	}

	const hitsMatter = (fx: number, fy: number) => {
		Body.setPosition(cand, { x: ox + fx, y: oy + fy });
		for (const o of obsBodies) {
			if (bodiesCollide(cand, o)) return true;
		}
		return false;
	};

	let lo = 0;
	let hi = 1;
	if (!hitsMatter(delta.x, delta.y)) {
		Body.setPosition(cand, { x: ox, y: oy });
		lo = 1;
	} else {
		Body.setPosition(cand, { x: ox, y: oy });
		for (let i = 0; i < iters; i++) {
			const mid = (lo + hi) / 2;
			if (hitsMatter(delta.x * mid, delta.y * mid)) hi = mid;
			else lo = mid;
		}
		Body.setPosition(cand, { x: ox, y: oy });
	}

	// Matter bodies can sit slightly inside curved Paper fills (chord error).
	// Only then ease back — never invent a standing gap.
	if (lo > 1e-5) {
		path.translate(delta.multiply(lo));
		const bites = obstacles.some((o) => paperPathsOverlap(path, o));
		path.translate(delta.multiply(-lo));
		if (bites) {
			let plo = 0;
			let phi = lo;
			for (let i = 0; i < 8; i++) {
				const mid = (plo + phi) / 2;
				path.translate(delta.multiply(mid));
				const hit = obstacles.some((o) => paperPathsOverlap(path, o));
				path.translate(delta.multiply(-mid));
				if (hit) phi = mid;
				else plo = mid;
			}
			lo = plo;
		}
	}
	return lo;
}

export function anyOverlap(paths: paper.Path[], obstacles: paper.Path[]): boolean {
	return paths.some((p) => pathOverlapsAny(p, obstacles));
}

const ROTATE_ANGLE_ITERS = 10;
const MIN_ROTATE_DEG = 0.15;
const CONTACT_PIVOT_PAD = 8;

function selectionCenter(paths: paper.Path[]): paper.Point {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const p of paths) {
		const b = p.bounds;
		if (b.left < left) left = b.left;
		if (b.top < top) top = b.top;
		if (b.right > right) right = b.right;
		if (b.bottom > bottom) bottom = b.bottom;
	}
	return new paper.Point((left + right) / 2, (top + bottom) / 2);
}

function restorePaths(
	befores: { path: paper.Path; pathData: string }[]
) {
	for (const b of befores) {
		b.path.pathData = b.pathData;
	}
}

function applyRotateAbout(paths: paper.Path[], degrees: number, pivot: paper.Point) {
	for (const p of paths) p.rotate(degrees, pivot);
}

/** Candidate pivots: center, contact points with nearby rocks, outline offsets. */
function gatherRotatePivots(paths: paper.Path[], obstacles: paper.Path[]): paper.Point[] {
	const pivots: paper.Point[] = [];
	const seen = new Set<string>();
	const add = (pt: paper.Point) => {
		const key = `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
		if (seen.has(key)) return;
		seen.add(key);
		pivots.push(pt);
	};

	const center = paths.length === 1 ? paths[0]!.bounds.center : selectionCenter(paths);
	add(center.clone());

	for (const path of paths) {
		const b = path.bounds;
		const rx = b.width * 0.45;
		const ry = b.height * 0.45;
		for (const [ox, oy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
			[0.7, 0.7],
			[-0.7, 0.7],
			[0.7, -0.7],
			[-0.7, -0.7]
		] as const) {
			add(center.add(new paper.Point(ox * rx, oy * ry)));
		}

		// Prefer pivots on the subject near contacts with obstacles.
		for (const other of obstacles) {
			if (!path.bounds.expand(CONTACT_PIVOT_PAD * 4).intersects(other.bounds)) continue;
			const onSubject = path.getNearestPoint(other.bounds.center);
			const onOther = other.getNearestPoint(onSubject);
			const dist = onSubject.getDistance(onOther);
			if (dist > CONTACT_PIVOT_PAD * 3) continue;
			add(onSubject);
			add(onOther);
			// Slightly outside the contact so the rock can roll around the blocker.
			const away = onSubject.subtract(onOther);
			if (away.length > 1e-4) {
				add(onOther.add(away.normalize().multiply(-2)));
				add(onSubject.add(away.normalize().multiply(2)));
			}
		}
	}

	return pivots;
}

/**
 * Largest |fraction| of `degrees` the group can rotate about `pivot` without
 * overlapping obstacles. Restores geometry afterward. Mirrors translation:
 * Matter binary-search first, then ease back only when Paper still penetrates.
 */
function maxFreeRotateFrac(
	paths: paper.Path[],
	obstacles: paper.Path[],
	degrees: number,
	pivot: paper.Point,
	befores: { path: paper.Path; pathData: string }[]
): number {
	applyRotateAbout(paths, degrees, pivot);
	const freeFull = !groupOverlaps(paths, obstacles);
	restorePaths(befores);
	if (freeFull) return 1;

	let lo = 0;
	let hi = 1;
	for (let i = 0; i < ROTATE_ANGLE_ITERS; i++) {
		const mid = (lo + hi) / 2;
		applyRotateAbout(paths, degrees * mid, pivot);
		if (groupOverlaps(paths, obstacles)) hi = mid;
		else lo = mid;
		restorePaths(befores);
	}

	// Matter chords can sit slightly inside curved fills after rotation.
	// Only then ease the angle back — never invent a standing gap.
	if (lo > 1e-5) {
		applyRotateAbout(paths, degrees * lo, pivot);
		const bites = groupOverlaps(paths, obstacles);
		restorePaths(befores);
		if (bites) {
			let plo = 0;
			let phi = lo;
			for (let i = 0; i < 8; i++) {
				const mid = (plo + phi) / 2;
				applyRotateAbout(paths, degrees * mid, pivot);
				const hit = groupOverlaps(paths, obstacles);
				restorePaths(befores);
				if (hit) phi = mid;
				else plo = mid;
			}
			lo = plo;
		}
	}
	return lo;
}

/**
 * Rotate paths without ever leaving them overlapping obstacles.
 * Tries the natural pivot first (own center / group center), then contact and
 * off-center pivots, taking the largest free angle that still moves.
 * Returns the applied degrees (0 if nothing free).
 */
export function rotateKinematic(
	paths: paper.Path[],
	degrees: number,
	obstacles: paper.Path[],
	preferredPivot?: paper.Point
): number {
	if (paths.length === 0 || Math.abs(degrees) < MIN_ROTATE_DEG) return 0;

	const befores = paths.map((p) => ({ path: p, pathData: p.pathData }));
	const pivots = gatherRotatePivots(paths, obstacles);
	if (preferredPivot) {
		pivots.unshift(preferredPivot.clone());
	}

	let bestFrac = 0;
	let bestPivot = pivots[0] ?? selectionCenter(paths);

	for (const pivot of pivots) {
		const frac = maxFreeRotateFrac(paths, obstacles, degrees, pivot, befores);
		if (frac > bestFrac + 1e-4) {
			bestFrac = frac;
			bestPivot = pivot;
			if (bestFrac >= 0.999) break;
		}
	}

	const applied = degrees * bestFrac;
	if (Math.abs(applied) < MIN_ROTATE_DEG) {
		restorePaths(befores);
		return 0;
	}

	applyRotateAbout(paths, applied, bestPivot);
	if (groupOverlaps(paths, obstacles)) {
		// Safety: never commit an overlapping pose.
		restorePaths(befores);
		return 0;
	}

	for (const p of paths) {
		onPathTranslated?.(p);
		rebuildFromPath(p);
	}
	return applied;
}

/** Unlock selected bodies for kinematic dragging.
 *  `allPlaced` prunes orphan Matter bodies that are no longer on the canvas. */
export function beginDrag(paths: paper.Path[], allPlaced?: paper.Path[]) {
	dragFrame = 0;
	lastDragLogAt = 0;
	const t0 = performance.now();
	if (allPlaced) pruneBodiesExcept(allPlaced);
	debugPhysicsSnapshot('beginDrag:before-rebuild', allPlaced ?? paths, {
		movers: paths.length
	});
	// Resample every remaining registered body from current Paper geometry so
	// drag nestling matches the visible outline (same chords for movers + obstacles).
	for (const path of [...links.keys()]) {
		rebuildFromPath(path);
	}
	for (const p of paths) {
		let link = links.get(p);
		if (!link) {
			syncBody(p);
			link = links.get(p);
		}
		if (!link) continue;
		// Stay static — we move bodies by setPosition and test with Collision.
		// Non-static + Engine.update tunnels through other static rocks.
		Body.setStatic(link.body, true);
		Body.setVelocity(link.body, { x: 0, y: 0 });
		Body.setAngularVelocity(link.body, 0);
		link.lastX = link.body.position.x;
		link.lastY = link.body.position.y;
	}
	debugPhysicsSnapshot('beginDrag:after-rebuild', allPlaced ?? paths, {
		movers: paths.map((p, i) => pathDebugId(p, i)),
		obstacleCount: Math.max(0, links.size - paths.length)
	});
	let fixed = 0;
	if (allPlaced?.length) {
		fixed = reconcileRegisteredOverlaps(allPlaced);
	}
	debugJson('drag:begin', {
		movers: paths.map((p, i) => pathDebugId(p, i)),
		obstacleCount: Math.max(0, links.size - paths.length),
		reconciledFalseOverlaps: fixed,
		ms: +(performance.now() - t0).toFixed(2)
	});
}

/** Lock bodies again after drag ends; rebuild from Paper so rest pose matches
 *  the same samples rotate/placement use (avoids angle-dependent drift). */
export function endDrag(paths: paper.Path[], allPlaced?: paper.Path[]) {
	const t0 = performance.now();
	for (const p of paths) {
		const link = links.get(p);
		if (!link) continue;
		Body.setVelocity(link.body, { x: 0, y: 0 });
		Body.setAngularVelocity(link.body, 0);
		applyBodyToPath(p, link);
		Body.setStatic(link.body, true);
		rebuildFromPath(p);
	}
	const reconcileSet = allPlaced ?? [...links.keys()];
	const fixed = reconcileSet.length ? reconcileRegisteredOverlaps(reconcileSet) : 0;
	debugJson('drag:end', {
		movers: paths.map((p, i) => pathDebugId(p, i)),
		frames: dragFrame,
		reconciledFalseOverlaps: fixed,
		ms: +(performance.now() - t0).toFixed(2)
	});
	dragFrame = 0;
}

type Mover = { path: paper.Path; link: BodyLink; x: number; y: number };

function moversHitObstacles(movers: Mover[], obstacles: Matter.Body[]): boolean {
	for (const m of movers) {
		for (const o of obstacles) {
			if (bodiesCollide(m.link.body, o)) return true;
		}
	}
	return false;
}

function placeMovers(movers: Mover[], ox: number, oy: number) {
	for (const m of movers) {
		Body.setPosition(m.link.body, { x: m.x + ox, y: m.y + oy });
	}
}

/** Largest fraction of (dx,dy) the group can travel without penetrating obstacles. */
function maxFreeFrac(movers: Mover[], obstacles: Matter.Body[], dx: number, dy: number): number {
	if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) return 0;

	placeMovers(movers, 0, 0);
	// Residual Matter-only overlap should already be filtered from `obstacles`.
	// If anything remains, nestling would stick at 0 — allow the step and let
	// Paper ease-back handle true bites.
	if (moversHitObstacles(movers, obstacles)) return 1;

	placeMovers(movers, dx, dy);
	const freeFull = !moversHitObstacles(movers, obstacles);
	placeMovers(movers, 0, 0);
	if (freeFull) return 1;

	let lo = 0;
	let hi = 1;
	for (let i = 0; i < SEARCH_ITERS; i++) {
		const mid = (lo + hi) / 2;
		placeMovers(movers, dx * mid, dy * mid);
		if (moversHitObstacles(movers, obstacles)) hi = mid;
		else lo = mid;
	}
	placeMovers(movers, 0, 0);
	return lo;
}

/** Matter contact without Paper fill bite — ignore as a Matter nestling wall. */
function isGhostObstacle(movers: Mover[], obstaclePath: paper.Path, obstacleBody: Matter.Body): boolean {
	for (const m of movers) {
		if (!bodiesCollide(m.link.body, obstacleBody)) continue;
		if (!fillsPenetrate(m.path, obstaclePath)) return true;
	}
	return false;
}

/**
 * Largest fraction of (dx,dy) movers can travel before Paper fills penetrate.
 * Used so ghost-skipped Matter walls still nestle flush against visible rocks.
 */
function maxPaperFreeFrac(
	movers: Mover[],
	paperObstacles: paper.Path[],
	dx: number,
	dy: number
): number {
	if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) return 0;
	const origins = movers.map((m) => m.path.position.clone());
	const moverPaths = movers.map((m) => m.path);

	const reset = () => {
		for (let i = 0; i < movers.length; i++) {
			movers[i]!.path.position = origins[i]!;
			onPathTranslated?.(movers[i]!.path);
		}
	};

	const apply = (frac: number) => {
		for (let i = 0; i < movers.length; i++) {
			movers[i]!.path.position = origins[i]!.add(new paper.Point(dx * frac, dy * frac));
			onPathTranslated?.(movers[i]!.path);
		}
	};

	const hits = () => {
		for (const m of movers) {
			for (const o of paperObstacles) {
				if (fillsPenetrate(m.path, o)) return true;
			}
		}
		if (movers.length <= 1) return false;
		for (let i = 0; i < moverPaths.length; i++) {
			for (let j = i + 1; j < moverPaths.length; j++) {
				if (fillsPenetrate(moverPaths[i]!, moverPaths[j]!)) return true;
			}
		}
		return false;
	};

	// Already penetrating at rest — don't invent motion; caller handles escape.
	if (hits()) return 0;

	apply(1);
	const freeFull = !hits();
	reset();
	if (freeFull) return 1;

	let lo = 0;
	let hi = 1;
	for (let i = 0; i < SEARCH_ITERS; i++) {
		const mid = (lo + hi) / 2;
		apply(mid);
		if (hits()) hi = mid;
		else lo = mid;
		reset();
	}
	return lo;
}

/**
 * Probe slightly into the blocked push to read a Matter contact normal, then
 * return a unit tangent aligned with the remaining drag (for edge sliding).
 */
function slideTangentFromContact(
	movers: Mover[],
	obstacles: Matter.Body[],
	baseX: number,
	baseY: number,
	remainX: number,
	remainY: number
): { tx: number; ty: number } | null {
	const remainLen = Math.hypot(remainX, remainY);
	if (remainLen < 1e-6 || obstacles.length === 0) return null;

	const ux = remainX / remainLen;
	const uy = remainY / remainLen;
	placeMovers(movers, baseX + ux * NORMAL_PROBE, baseY + uy * NORMAL_PROBE);

	let bestDepth = -1;
	let nx = 0;
	let ny = 0;
	for (const m of movers) {
		for (const o of obstacles) {
			const col = Collision.collides(m.link.body, o);
			if (!col?.collided) continue;
			const depth = col.depth ?? 0;
			if (depth < bestDepth) continue;
			bestDepth = depth;
			// Normal is from bodyA → bodyB. Flip so it faces the mover.
			let nnx = col.normal.x;
			let nny = col.normal.y;
			if (col.bodyA === m.link.body) {
				nnx = -nnx;
				nny = -nny;
			}
			nx = nnx;
			ny = nny;
		}
	}
	placeMovers(movers, 0, 0);
	if (bestDepth < 0) return null;

	const nLen = Math.hypot(nx, ny);
	if (nLen < 1e-6) return null;
	nx /= nLen;
	ny /= nLen;

	// Unit tangent; pick the orientation that matches the remaining drag.
	let tx = -ny;
	let ty = nx;
	if (tx * remainX + ty * remainY < 0) {
		tx = -tx;
		ty = -ty;
	}
	return { tx, ty };
}

/**
 * Move unlocked paths toward `delta` (desired Paper translation of the group).
 * Nestles flush along the free portion of the push; when blocked, still slides
 * along the contact tangent (damped) so a clear axis path is not required.
 * Multi-select stays rigid (shared translation).
 */
export function moveKinematic(paths: paper.Path[], delta: paper.Point): boolean {
	if (!engine || paths.length === 0) return false;
	if (delta.length < 1e-6) return true;

	const t0 = performance.now();
	dragFrame += 1;

	let dx = delta.x;
	let dy = delta.y;
	const wantTravel = Math.hypot(dx, dy);
	let capped = false;
	if (wantTravel > MAX_FRAME_TRAVEL) {
		const s = MAX_FRAME_TRAVEL / wantTravel;
		dx *= s;
		dy *= s;
		capped = true;
	}
	const travel = Math.hypot(dx, dy);

	const movers: Mover[] = [];
	const moving = new Set(paths);
	for (const p of paths) {
		const link = links.get(p);
		if (!link) return false;
		movers.push({ path: p, link, x: link.body.position.x, y: link.body.position.y });
	}

	// Use registered bodies for Matter nestling. Skip Matter-only (ghost)
	// contacts so chord inflation can't invent invisible walls — but keep every
	// obstacle path for Paper nestling / ease-back so we don't dig into fills.
	const obstacles: Matter.Body[] = [];
	const paperObstacles: paper.Path[] = [];
	let ghostSkipped = 0;
	for (const [path, link] of links) {
		if (moving.has(path)) continue;
		paperObstacles.push(path);
		if (isGhostObstacle(movers, path, link.body)) {
			ghostSkipped++;
			continue;
		}
		obstacles.push(link.body);
	}

	placeMovers(movers, 0, 0);
	const matterRestHit = moversHitObstacles(movers, obstacles);
	const paperRestHit = movers.some((m) =>
		paperObstacles.some((o) => fillsPenetrate(m.path, o))
	);
	const ghostRest = ghostSkipped > 0 || (matterRestHit && !paperRestHit);

	const candidates: { x: number; y: number }[] = [];
	const fMatter = maxFreeFrac(movers, obstacles, dx, dy);
	const fPaper = maxPaperFreeFrac(movers, paperObstacles, dx, dy);
	// Never travel farther than Paper allows — ghost skips must not dig into fills.
	const fNestle = Math.min(fMatter, fPaper);
	const nestX = dx * fNestle;
	const nestY = dy * fNestle;
	candidates.push({ x: nestX, y: nestY });

	let usedSlide = false;
	if (fNestle < 0.999) {
		const remainX = dx - nestX;
		const remainY = dy - nestY;

		// Primary: project the blocked remainder onto the contact tangent and
		// apply a damped slide from the nestled pose — works even when the
		// raw delta would dig into the other rock.
		const tangent = slideTangentFromContact(movers, obstacles, nestX, nestY, remainX, remainY);
		if (tangent) {
			const along = remainX * tangent.tx + remainY * tangent.ty;
			const slideX = tangent.tx * along * SLIDE_GAIN;
			const slideY = tangent.ty * along * SLIDE_GAIN;
			if (Math.abs(slideX) > 1e-4 || Math.abs(slideY) > 1e-4) {
				usedSlide = true;
				placeMovers(movers, nestX, nestY);
				const fromNest = movers.map((m) => ({
					...m,
					x: m.link.body.position.x,
					y: m.link.body.position.y
				}));
				const fSlideMatter = maxFreeFrac(fromNest, obstacles, slideX, slideY);
				// Paper must also accept the slide from the nestled Paper pose.
				const nestOrigins = movers.map((m) => m.path.position.clone());
				for (const m of movers) {
					m.path.position = m.path.position.add(new paper.Point(nestX, nestY));
					onPathTranslated?.(m.path);
				}
				const fSlidePaper = maxPaperFreeFrac(movers, paperObstacles, slideX, slideY);
				for (let i = 0; i < movers.length; i++) {
					movers[i]!.path.position = nestOrigins[i]!;
					onPathTranslated?.(movers[i]!.path);
				}
				const fSlide = Math.min(fSlideMatter, fSlidePaper);
				candidates.push({
					x: nestX + slideX * fSlide,
					y: nestY + slideY * fSlide
				});
				placeMovers(movers, 0, 0);
			}
		}

		// Fallback: axis / sequential slides when no contact normal is found.
		const addAxis = (ax: number, ay: number) => {
			const fm = maxFreeFrac(movers, obstacles, ax, ay);
			const fp = maxPaperFreeFrac(movers, paperObstacles, ax, ay);
			const f = Math.min(fm, fp);
			candidates.push({ x: ax * f, y: ay * f });
			return f;
		};
		const fX = addAxis(dx, 0);
		const fY = addAxis(0, dy);

		placeMovers(movers, dx * fX, 0);
		const startsAfterX = movers.map((m) => ({
			...m,
			x: m.link.body.position.x,
			y: m.link.body.position.y
		}));
		const originsAfterX = movers.map((m) => m.path.position.clone());
		for (const m of movers) {
			m.path.position = m.path.position.add(new paper.Point(dx * fX, 0));
			onPathTranslated?.(m.path);
		}
		const fY2 = Math.min(
			maxFreeFrac(startsAfterX, obstacles, 0, dy),
			maxPaperFreeFrac(movers, paperObstacles, 0, dy)
		);
		for (let i = 0; i < movers.length; i++) {
			movers[i]!.path.position = originsAfterX[i]!;
			onPathTranslated?.(movers[i]!.path);
		}
		candidates.push({ x: dx * fX, y: dy * fY2 });
		placeMovers(movers, 0, 0);

		placeMovers(movers, 0, dy * fY);
		const startsAfterY = movers.map((m) => ({
			...m,
			x: m.link.body.position.x,
			y: m.link.body.position.y
		}));
		const originsAfterY = movers.map((m) => m.path.position.clone());
		for (const m of movers) {
			m.path.position = m.path.position.add(new paper.Point(0, dy * fY));
			onPathTranslated?.(m.path);
		}
		const fX2 = Math.min(
			maxFreeFrac(startsAfterY, obstacles, dx, 0),
			maxPaperFreeFrac(movers, paperObstacles, dx, 0)
		);
		for (let i = 0; i < movers.length; i++) {
			movers[i]!.path.position = originsAfterY[i]!;
			onPathTranslated?.(movers[i]!.path);
		}
		candidates.push({ x: dx * fX2, y: dy * fY });
		placeMovers(movers, 0, 0);
	}

	let best = candidates[0]!;
	let bestScore = -1;
	const targetLen2 = dx * dx + dy * dy;
	for (const c of candidates) {
		// Prefer progress toward the cursor (dot product), then total travel.
		const score = (c.x * dx + c.y * dy) / Math.max(targetLen2, 1e-8);
		if (
			score > bestScore + 1e-6 ||
			(Math.abs(score - bestScore) < 1e-6 &&
				c.x * c.x + c.y * c.y > best.x * best.x + best.y * best.y)
		) {
			best = c;
			bestScore = score;
		}
	}

	const appliedTravel = Math.hypot(best.x, best.y);
	const sticky = travel > 1 && appliedTravel < 0.25;

	const finishLog = (result: 'moved' | 'blocked' | 'eased-out', paperFrac = 1) => {
		const ms = performance.now() - t0;
		const now = performance.now();
		const interesting =
			ghostRest ||
			sticky ||
			matterRestHit ||
			paperRestHit ||
			result !== 'moved' ||
			fNestle < 0.5 ||
			ms > 8 ||
			capped;
		if (!interesting) return;
		if (now - lastDragLogAt < 45 && dragFrame > 3 && ms <= 12 && !ghostRest) return;
		lastDragLogAt = now;
		debugJson('drag:frame', {
			frame: dragFrame,
			result,
			want: { x: +delta.x.toFixed(2), y: +delta.y.toFixed(2), len: +wantTravel.toFixed(2) },
			step: { x: +dx.toFixed(2), y: +dy.toFixed(2), len: +travel.toFixed(2), capped },
			fMatter: +fMatter.toFixed(4),
			fPaper: +fPaper.toFixed(4),
			fNestle: +fNestle.toFixed(4),
			best: { x: +best.x.toFixed(2), y: +best.y.toFixed(2), len: +appliedTravel.toFixed(2) },
			paperFrac: +paperFrac.toFixed(4),
			ghostRest,
			ghostSkipped,
			matterRestHit,
			paperRestHit,
			sticky,
			usedSlide,
			movers: movers.length,
			obstacles: obstacles.length,
			paperObstacles: paperObstacles.length,
			ms: +ms.toFixed(2)
		});
	};

	if (Math.abs(best.x) < 1e-4 && Math.abs(best.y) < 1e-4) {
		placeMovers(movers, 0, 0);
		finishLog('blocked');
		return false;
	}

	const paperOrigins = movers.map((m) => m.path.position.clone());
	const moverPaths = movers.map((m) => m.path);

	const resetPose = () => {
		placeMovers(movers, 0, 0);
		for (const m of movers) {
			m.link.lastX = m.x;
			m.link.lastY = m.y;
		}
		for (let i = 0; i < movers.length; i++) {
			movers[i]!.path.position = paperOrigins[i]!;
			onPathTranslated?.(movers[i]!.path);
		}
	};

	const applyFrac = (frac: number) => {
		const fx = best.x * frac;
		const fy = best.y * frac;
		for (const m of movers) {
			Body.setPosition(m.link.body, { x: m.x + fx, y: m.y + fy });
			m.link.lastX = m.x;
			m.link.lastY = m.y;
			applyBodyToPath(m.path, m.link);
		}
	};

	const poseOverlaps = () => {
		// Paper-only against ALL obstacles (including Matter ghosts).
		if (movers.some((m) => paperObstacles.some((o) => fillsPenetrate(m.path, o)))) {
			return true;
		}
		if (movers.length <= 1) return false;
		for (let i = 0; i < moverPaths.length; i++) {
			for (let j = i + 1; j < moverPaths.length; j++) {
				if (fillsPenetrate(moverPaths[i]!, moverPaths[j]!)) return true;
			}
		}
		return false;
	};

	// Nestle with registered Matter bodies, then ease back only for true Paper bites.
	applyFrac(1);
	let frac = 1;
	if (poseOverlaps()) {
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < SEARCH_ITERS; i++) {
			const mid = (lo + hi) / 2;
			resetPose();
			applyFrac(mid);
			if (poseOverlaps()) hi = mid;
			else lo = mid;
		}
		frac = lo;
		resetPose();
		if (frac < 1e-4) {
			finishLog('eased-out', 0);
			return false;
		}
		applyFrac(frac);
		if (poseOverlaps()) {
			resetPose();
			finishLog('eased-out', frac);
			return false;
		}
	}

	finishLog('moved', frac);
	return true;
}
