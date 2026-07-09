import { ROCK_COUNT } from './rocks';

export type AspectId = '1:1' | '4:5' | '16:9';

export interface Aspect {
	id: AspectId;
	w: number;
	h: number;
}

export const ASPECTS: Aspect[] = [
	{ id: '1:1', w: 1, h: 1 },
	{ id: '4:5', w: 4, h: 5 },
	{ id: '16:9', w: 16, h: 9 }
];

export interface Swatch {
	name: string;
	hex: string;
}

/** Full Project Everyone palette (Ink and Paper are UI chrome). */
export const PALETTE: Swatch[] = [
	{ name: 'Project Everyone Yellow', hex: '#FFF788' },
	{ name: 'Activate Red', hex: '#ED4E3D' },
	{ name: 'Soft Coral', hex: '#FF9673' },
	{ name: 'Dawn Pink', hex: '#F5DEFF' },
	{ name: 'Bright Magenta', hex: '#DF6BFF' },
	{ name: 'Clear Blue', hex: '#C8FBFF' },
	{ name: 'Live Green', hex: '#95FF9F' },
	{ name: 'Unity Blue', hex: '#4371DB' },
	{ name: 'Deep Teal', hex: '#1A4654' },
	{ name: 'Ink', hex: '#101A31' },
	{ name: 'Paper', hex: '#FFFFFF' }
];

/** Colors that cycle as fills for placed rocks (full palette, including Paper). */
export const ROCK_COLORS: Swatch[] = PALETTE;

const PAPER_HEX = '#FFFFFF';
const INK_HEX = '#101A31';

export function hexEq(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** True when a rock fill/swatch must be hidden for the current canvas background. */
export function isRockColorExcluded(hex: string, canvasBg: string | null): boolean {
	if (canvasBg === null) return hexEq(hex, PAPER_HEX);
	return hexEq(hex, canvasBg);
}

/** Rock palette entries available in UI / shuffle for the given background. */
export function rockColorsForUi(canvasBg: string | null): Swatch[] {
	return ROCK_COLORS.filter((c) => !isRockColorExcluded(c.hex, canvasBg));
}

export function rockColorIndex(hex: string): number {
	return ROCK_COLORS.findIndex((c) => hexEq(c.hex, hex));
}

/** Canvas artboard backgrounds: full palette (incl. white) plus transparent. */
export interface CanvasBgSwatch {
	name: string;
	/** `null` = transparent artboard / export backdrop. */
	hex: string | null;
}

export const CANVAS_BG_COLORS: CanvasBgSwatch[] = [
	...PALETTE,
	{ name: 'Transparent', hex: null }
];

/** Reorderable top-bar swatch: stable key, solid fill hex, dice-pool flag.
 *  `hex` stays `string | null` for typing; the bar never inserts null. */
export interface BgSwatch {
	key: string;
	hex: string | null;
	enabled: boolean;
}

function defaultBgSwatches(): BgSwatch[] {
	return [
		{ key: PAPER_HEX, hex: PAPER_HEX, enabled: true },
		...PALETTE.filter((p) => !hexEq(p.hex, PAPER_HEX)).map((p) => ({
			key: p.hex,
			hex: p.hex,
			enabled: true
		}))
	];
}

function bgHexEq(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	return hexEq(a, b);
}

/** Enabled swatches first (order preserved), then disabled (order preserved). */
export function partitionBgSwatches(list: BgSwatch[]): BgSwatch[] {
	const enabled: BgSwatch[] = [];
	const disabled: BgSwatch[] = [];
	for (const s of list) {
		if (s.enabled) enabled.push(s);
		else disabled.push(s);
	}
	return [...enabled, ...disabled];
}

export { ROCK_COUNT };

export interface RockSize {
	label: string;
	/** Tallest-rock height as a fraction of sqrt(canvas area), so the same
	 *  size reads identically across aspect ratios. */
	fraction: number;
}

export const ROCK_SIZES: RockSize[] = [
	{ label: 'S', fraction: 0.48 },
	{ label: 'M', fraction: 0.72 },
	{ label: 'L', fraction: 1.12 }
];

export type Mode = 'cluster' | 'stack';
/** Active canvas interaction tool. Cursor selects/moves; shape places rocks;
 *  none is used while generate settings are open (no canvas tool active). */
export type CanvasTool = 'cursor' | 'shape' | 'none';
/** Which bottom-toolbar settings pill is open. Cursor has no sub-items. */
export type ToolPanel = 'none' | 'shape' | 'lucky';

export interface UploadedImage {
	id: string;
	src: string;
}

class AppState {
	canvasTool: CanvasTool = $state('cursor');
	toolPanel: ToolPanel = $state('none');
	mode: Mode = $state('cluster');
	aspect: AspectId = $state('4:5');
	rockIndex = $state(0);
	colorIndex = $state(0);
	placedCount = $state(0);
	sizeIndex = $state(1);
	rotation = $state(0);
	clearVersion = $state(0);
	exportVersion = $state(0);
	undoVersion = $state(0);
	redoVersion = $state(0);
	canUndo = $state(false);
	canRedo = $state(false);

	/** Pool for "I'm feeling lucky" generation. Size uses `sizeIndex` (shared
	 *  with place). Toggling never leaves a category completely empty. */
	colorEnabled = $state(ROCK_COLORS.map(() => true));
	shapeEnabled = $state(Array.from({ length: ROCK_COUNT }, () => true));
	shuffleSeed = $state(0);

	/** Uploaded images available to attach to shapes. */
	images = $state<UploadedImage[]>([]);
	/** Image currently being masked/panned/zoomed in the canvas edit overlay. */
	imageEditId: string | null = $state(null);
	/** The single image that sits behind (fills) every shape, or null. Only one
	 *  image may fill all shapes at a time. */
	backgroundImageId: string | null = $state(null);
	/** Artboard backdrop color (`null` = transparent). Defaults to Paper/white. */
	canvasBg: string | null = $state('#FFFFFF');
	/** Bumped when canvas bg changes so Canvas can recolor rocks that matched the new bg. */
	canvasBgVersion = $state(0);
	/** Fill swap for the latest bg change: rocks with `from` become `to`. */
	bgRecolor: { from: string; to: string } | null = $state(null);
	/** Set while coercing colorIndex on bg change so Canvas won't recolor the selection. */
	skipSelectionColorApply = false;
	/** Top-bar bg swatches (leftmost = canvas background). */
	bgSwatches: BgSwatch[] = $state(defaultBgSwatches());
	/** Bumped by the top-bar dice to shuffle unlocked rock fill colors. */
	colorShuffleVersion = $state(0);
	private imageSeq = 0;

	/** Enabled top-bar colors that are not the current canvas bg (shape/tip pickers). */
	get availableRockColors(): Swatch[] {
		return this.bgSwatches.flatMap((s) => {
			if (!s.enabled || s.hex === null || isRockColorExcluded(s.hex, this.canvasBg)) return [];
			const named = PALETTE.find((p) => hexEq(p.hex, s.hex!));
			return [{ name: named?.name ?? s.hex, hex: s.hex }];
		});
	}

	/** True when this ROCK_COLORS index is in the enabled non-bg canvas-bar pool. */
	isRockColorAvailable(i: number): boolean {
		const swatch = ROCK_COLORS[i];
		return !!swatch && this.availableRockColors.some((c) => hexEq(c.hex, swatch.hex));
	}

	/** If colorIndex points outside the picker pool, move it to the first available. */
	private coerceColorIndex() {
		const available = this.availableRockColors;
		if (!available.length) return;
		const current = ROCK_COLORS[this.colorIndex];
		if (current && available.some((c) => hexEq(c.hex, current.hex))) return;
		const next = rockColorIndex(available[0].hex);
		if (next >= 0) this.colorIndex = next;
	}

	selectCanvasBg(hex: string | null) {
		if (bgHexEq(hex, this.canvasBg)) return;
		const prev = this.canvasBg;
		const next = hex;
		this.canvasBg = next;

		let recolor: { from: string; to: string } | null = null;
		if (typeof next === 'string') {
			if (typeof prev === 'string') {
				recolor = { from: next, to: prev };
			} else {
				// Leaving transparent: replace rocks that had the new bg with white,
				// or Ink when the new bg is already white.
				recolor = {
					from: next,
					to: hexEq(next, PAPER_HEX) ? INK_HEX : PAPER_HEX
				};
			}
		}
		this.bgRecolor = recolor;
		this.canvasBgVersion++;
		this.skipSelectionColorApply = true;
		this.coerceColorIndex();
		// Effects flush before this microtask, so selection recolor can see the flag.
		queueMicrotask(() => {
			this.skipSelectionColorApply = false;
		});
	}

	/** Enabled top-bar hexes valid as rock fills for the current canvas bg. */
	get enabledBgRockColors(): string[] {
		return this.bgSwatches.flatMap((s) =>
			s.enabled && s.hex !== null && !isRockColorExcluded(s.hex, this.canvasBg) ? [s.hex] : []
		);
	}

	/** When a swatch becomes canvas bg (index 0), it must stay in the pool UI as on. */
	private ensureLeftmostEnabled() {
		const left = this.bgSwatches[0];
		if (!left || left.enabled) return;
		const next = this.bgSwatches.slice();
		next[0] = { ...left, enabled: true };
		this.bgSwatches = next;
	}

	/**
	 * Splice-reorder top-bar swatches.
	 * With `deferBg`, only mutates order (for live drag); call `finalizeBgSwatchOrder` on drag end.
	 */
	reorderBgSwatch(from: number, to: number, opts?: { deferBg?: boolean }) {
		const n = this.bgSwatches.length;
		if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
		const next = this.bgSwatches.slice();
		const [item] = next.splice(from, 1);
		if (!item) return;
		// Dragging onto the bg slot reactivates a disabled swatch.
		const placed = to === 0 && !item.enabled ? { ...item, enabled: true } : item;
		next.splice(to, 0, placed);
		this.bgSwatches = next;
		if (opts?.deferBg) return;
		this.ensureLeftmostEnabled();
		const newLeft = this.bgSwatches[0]?.hex ?? null;
		if (!bgHexEq(this.canvasBg, newLeft)) this.selectCanvasBg(newLeft);
	}

	/** After drag: re-enable leftmost (so a disabled drag-to-bg sticks), then partition, apply bg. */
	finalizeBgSwatchOrder() {
		this.ensureLeftmostEnabled();
		this.bgSwatches = partitionBgSwatches(this.bgSwatches);
		const left = this.bgSwatches[0]?.hex ?? null;
		if (!bgHexEq(left, this.canvasBg)) this.selectCanvasBg(left);
		else this.coerceColorIndex();
	}

	/**
	 * Toggle a swatch in/out of the color-shuffle pool.
	 * Off → partition (disabled to the right); if it was canvas bg, new leftmost becomes bg.
	 * On → partition so it joins the end of the enabled group. Never empties the rock-color pool.
	 * Always keeps shape-tool `colorIndex` on an enabled non-bg color when the pool changes.
	 */
	toggleBgSwatch(index: number) {
		const swatch = this.bgSwatches[index];
		if (!swatch) return;

		if (!swatch.enabled) {
			const next = this.bgSwatches.slice();
			next[index] = { ...swatch, enabled: true };
			this.bgSwatches = partitionBgSwatches(next);
			this.coerceColorIndex();
			return;
		}

		const wasLeft = index === 0;
		const next = this.bgSwatches.slice();
		next[index] = { ...swatch, enabled: false };
		const partitioned = partitionBgSwatches(next);

		let newCanvasBg = this.canvasBg;
		if (wasLeft) {
			const left = partitioned[0];
			if (left && !left.enabled) partitioned[0] = { ...left, enabled: true };
			newCanvasBg = partitioned[0]?.hex ?? this.canvasBg;
		}

		const poolAfter = partitioned.flatMap((s) =>
			s.enabled && s.hex !== null && !isRockColorExcluded(s.hex, newCanvasBg) ? [s.hex] : []
		);
		if (poolAfter.length === 0) return;

		this.bgSwatches = partitioned;
		if (wasLeft) {
			this.ensureLeftmostEnabled();
			this.selectCanvasBg(this.bgSwatches[0]?.hex ?? null);
		} else {
			this.coerceColorIndex();
		}
	}

	/** Move a swatch to index 0 and select it as the canvas background. */
	moveBgSwatchToFront(index: number) {
		if (index <= 0 || index >= this.bgSwatches.length) return;
		this.reorderBgSwatch(index, 0);
	}

	/** Shuffle unlocked rock fill colors (Canvas watches `colorShuffleVersion`). */
	shuffleRockColors() {
		this.colorShuffleVersion++;
	}

	imageById(id: string | null): UploadedImage | undefined {
		return id ? this.images.find((im) => im.id === id) : undefined;
	}

	addImages(srcs: string[]) {
		const added = srcs.map((src) => ({ id: `img-${++this.imageSeq}`, src }));
		this.images = [...this.images, ...added];
	}

	removeImage(id: string) {
		this.images = this.images.filter((im) => im.id !== id);
		if (this.backgroundImageId === id) this.backgroundImageId = null;
		if (this.imageEditId === id) this.cancelImageEdit();
	}

	startImageEdit(id: string) {
		this.imageEditId = id;
	}

	saveImageEdit() {
		this.imageEditId = null;
	}

	cancelImageEdit() {
		this.imageEditId = null;
	}

	get imageEditing(): boolean {
		return this.imageEditId !== null;
	}

	/** Hex fills for generate shuffle — same pool as the canvas-bar rock colors. */
	get enabledColors(): string[] {
		const colors = this.enabledBgRockColors;
		return colors.length ? colors : this.availableRockColors.map((c) => c.hex);
	}

	/** Rock indices currently allowed in the shuffle. */
	get enabledShapes(): number[] {
		return this.shapeEnabled.reduce<number[]>((acc, on, i) => {
			if (on) acc.push(i);
			return acc;
		}, []);
	}

	get nextColor(): Swatch {
		const current = ROCK_COLORS[this.colorIndex];
		if (current && this.availableRockColors.some((c) => hexEq(c.hex, current.hex))) {
			return current;
		}
		return this.availableRockColors[0] ?? ROCK_COLORS[0];
	}

	get rockSize(): RockSize {
		return ROCK_SIZES[this.sizeIndex];
	}

	cycleRock(direction: 1 | -1) {
		this.rockIndex = (this.rockIndex + direction + ROCK_COUNT) % ROCK_COUNT;
	}

	selectRock(i: number) {
		this.rockIndex = i;
	}

	cycleAspect() {
		const i = ASPECTS.findIndex((a) => a.id === this.aspect);
		this.aspect = ASPECTS[(i + 1) % ASPECTS.length].id;
	}

	cycleSize() {
		this.sizeIndex = (this.sizeIndex + 1) % ROCK_SIZES.length;
	}

	rotateBy(degrees: number) {
		this.rotation = (this.rotation + degrees + 360) % 360;
	}

	toggleMode() {
		this.mode = this.mode === 'cluster' ? 'stack' : 'cluster';
	}

	/** Alias for the lucky-panel cycle control. */
	cycleMode() {
		this.toggleMode();
	}

	setMode(mode: Mode) {
		this.mode = mode;
	}

	/** Select/move existing rocks. Closes shape and generate settings. */
	selectCursorTool() {
		this.canvasTool = 'cursor';
		if (this.toolPanel === 'shape' || this.toolPanel === 'lucky') this.toolPanel = 'none';
	}

	/** Place new rocks. Opens shape settings; deactivates cursor. */
	selectShapeTool() {
		if (this.canvasTool === 'shape') {
			this.toolPanel = this.toolPanel === 'shape' ? 'none' : 'shape';
			return;
		}
		this.canvasTool = 'shape';
		this.toolPanel = 'shape';
	}

	/** Open/close lucky-roll parameter settings. Deactivates select/shape tools. */
	toggleLuckySettings() {
		if (this.toolPanel === 'lucky') {
			this.toolPanel = 'none';
			return;
		}
		this.canvasTool = 'none';
		this.toolPanel = 'lucky';
	}

	closeToolPanel() {
		this.toolPanel = 'none';
	}

	/** Flip one entry on/off, but never leave a category completely empty. */
	private toggleAt(flags: boolean[], i: number): boolean[] {
		const next = flags.slice();
		if (next[i] && next.filter(Boolean).length === 1) return flags;
		next[i] = !next[i];
		return next;
	}

	toggleColor(i: number) {
		if (!this.isRockColorAvailable(i)) return;
		// Only count available colors when preventing a fully-empty pool.
		const availableOn = ROCK_COLORS.reduce((n, c, j) => {
			if (!this.colorEnabled[j] || isRockColorExcluded(c.hex, this.canvasBg)) return n;
			return n + 1;
		}, 0);
		if (this.colorEnabled[i] && availableOn === 1) return;
		const next = this.colorEnabled.slice();
		next[i] = !next[i];
		this.colorEnabled = next;
	}

	toggleShape(i: number) {
		this.shapeEnabled = this.toggleAt(this.shapeEnabled, i);
	}

	/** Generate a new lucky layout (Canvas watches `shuffleSeed`). */
	generate() {
		this.shuffleSeed++;
	}

	advanceColor(direction: 1 | -1 = 1) {
		const available = this.availableRockColors;
		if (!available.length) return;
		const currentHex = ROCK_COLORS[this.colorIndex]?.hex;
		let pos = available.findIndex((c) => currentHex && hexEq(c.hex, currentHex));
		if (pos < 0) pos = direction > 0 ? -1 : 0;
		const next = available[(pos + direction + available.length) % available.length];
		const idx = rockColorIndex(next.hex);
		if (idx >= 0) this.colorIndex = idx;
	}

	selectColor(i: number) {
		if (!this.isRockColorAvailable(i)) return;
		this.colorIndex = i;
	}

	selectSize(i: number) {
		this.sizeIndex = i;
	}

	clear() {
		this.clearVersion++;
	}

	undo() {
		if (this.canUndo) this.undoVersion++;
	}

	redo() {
		if (this.canRedo) this.redoVersion++;
	}

	setUndoRedo(canUndo: boolean, canRedo: boolean) {
		this.canUndo = canUndo;
		this.canRedo = canRedo;
	}

	/** Open the download dialog (PNG or SVG). */
	exportPng() {
		this.exportVersion++;
	}
}

export const app = new AppState();
