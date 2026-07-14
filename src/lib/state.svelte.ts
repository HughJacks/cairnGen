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

/** Full palette for indexing; rock fills exclude Paper/Ink via isRockColorExcluded. */
export const ROCK_COLORS: Swatch[] = PALETTE;

const PAPER_HEX = '#FFFFFF';
const INK_HEX = '#101A31';

export function hexEq(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** True when a hex must never be used as a rock/shape fill (Paper, Ink, or current bg). */
export function isRockColorExcluded(hex: string, canvasBg: string | null): boolean {
	if (hexEq(hex, PAPER_HEX) || hexEq(hex, INK_HEX)) return true;
	if (canvasBg === null) return false;
	return hexEq(hex, canvasBg);
}

export function isPaperHex(hex: string | null): boolean {
	return hex !== null && hexEq(hex, PAPER_HEX);
}

/** Safe chromatic fill when remapping rocks off a bg color (never Paper/Ink). */
function safeRockFillHex(preferred: string | null, canvasBg: string | null): string {
	if (preferred && !isRockColorExcluded(preferred, canvasBg)) return preferred;
	for (const c of ROCK_COLORS) {
		if (!isRockColorExcluded(c.hex, canvasBg)) return c.hex;
	}
	return '#4371DB';
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

/** Fixed-order top-bar swatch: stable key, fill hex, rock-pool flag.
 *  Order is palette definition order — background is `canvasBg`, not index. */
export interface BgSwatch {
	key: string;
	hex: string | null;
	enabled: boolean;
}

export type ColorPaletteId = 'warm' | 'cool' | 'balanced';

export interface ColorPalette {
	id: ColorPaletteId;
	name: string;
	colors: Swatch[];
}

function paletteSwatch(hex: string): Swatch {
	const found = PALETTE.find((p) => hexEq(p.hex, hex));
	if (!found) throw new Error(`Unknown palette hex ${hex}`);
	return found;
}

/** Top-bar palettes. Chromatic colors + Paper (bg only) at the end. */
export const COLOR_PALETTES: ColorPalette[] = [
	{
		id: 'warm',
		name: 'Warm',
		colors: [
			paletteSwatch('#ED4E3D'),
			paletteSwatch('#FF9673'),
			paletteSwatch('#F5DEFF'),
			paletteSwatch('#DF6BFF'),
			paletteSwatch('#FFF788'),
			paletteSwatch(PAPER_HEX)
		]
	},
	{
		id: 'cool',
		name: 'Cool',
		colors: [
			paletteSwatch('#C8FBFF'),
			paletteSwatch('#95FF9F'),
			paletteSwatch('#4371DB'),
			paletteSwatch('#1A4654'),
			paletteSwatch('#FFF788'),
			paletteSwatch(PAPER_HEX)
		]
	},
	{
		id: 'balanced',
		name: 'Balanced',
		colors: [
			paletteSwatch('#F5DEFF'),
			paletteSwatch('#DF6BFF'),
			paletteSwatch('#C8FBFF'),
			paletteSwatch('#4371DB'),
			paletteSwatch('#1A4654'),
			paletteSwatch(PAPER_HEX)
		]
	}
];

function defaultBgSwatchesFor(paletteId: ColorPaletteId): BgSwatch[] {
	const palette = COLOR_PALETTES.find((p) => p.id === paletteId);
	const colors = palette?.colors ?? COLOR_PALETTES[0]!.colors;
	return colors.map((p) => ({
		key: p.hex,
		hex: p.hex,
		enabled: true
	}));
}

function bgHexEq(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	return hexEq(a, b);
}

export { ROCK_COUNT };

export interface RockSize {
	label: string;
	/**
	 * Shared rock width as a fraction of canvas height (one “shape unit”).
	 * Sized so roughly this many units stack into the artboard height:
	 * S ≈ 5–6, M ≈ 3–4, L ≈ 2.
	 */
	fraction: number;
}

export const ROCK_SIZES: RockSize[] = [
	{ label: 'S', fraction: 1 / 5.5 },
	{ label: 'M', fraction: 1 / 3.5 },
	{ label: 'L', fraction: 1 / 2 }
];

/** How many independent cairns the stack shuffle can generate. */
export const STACK_COUNT_MIN = 1;
export const STACK_COUNT_MAX = 5;

/**
 * Max stacks that can actually place for this aspect + rock size.
 * Rock width is a fraction of canvas height; packing uses height-normalized
 * width (aspect ratio) so pixel stage size does not matter.
 */
export function maxStackCountFor(aspectId: AspectId, sizeIndex: number): number {
	const aspect = ASPECTS.find((a) => a.id === aspectId) ?? ASPECTS[0]!;
	const ratio = aspect.w / aspect.h;
	const rock = ROCK_SIZES[sizeIndex]?.fraction ?? ROCK_SIZES[1]!.fraction;
	// Must match shuffle lane packing (side pad / min slot / min gap).
	const sidePad = rock * 0.15;
	const minSlot = rock * 0.95;
	const minGap = rock * 0.28;
	const usable = ratio - 2 * sidePad;
	if (usable < minSlot * 0.92) return STACK_COUNT_MIN;
	let n = 1;
	while (n < STACK_COUNT_MAX) {
		const need = (n + 1) * minSlot + n * minGap;
		if (need > usable + 1e-9) break;
		n++;
	}
	return n;
}

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
	/** Number of separate stacks when mode is `stack` (lucky generate). */
	stackCount = $state(3);
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
	/** Active top-bar color palette (Warm / Cool / Balanced). */
	activePaletteId: ColorPaletteId = $state('warm');
	/** Top-bar swatches for the active palette (fixed definition order). */
	bgSwatches: BgSwatch[] = $state(defaultBgSwatchesFor('warm'));
	/** Bumped by the top-bar shuffle to randomize unlocked rock fills. */
	colorShuffleVersion = $state(0);
	/** Bumped when switching Warm/Cool so Canvas recolors unlocked rocks into the new pool. */
	paletteSwitchVersion = $state(0);
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
				recolor = { from: next, to: safeRockFillHex(prev, next) };
			} else {
				// Leaving transparent: replace rocks that matched the new bg.
				recolor = { from: next, to: safeRockFillHex(null, next) };
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

	/** Set canvas background from a palette swatch (order unchanged).
	 *  Pinned colors are always enabled. */
	setCanvasBgFromSwatch(index: number): boolean {
		const swatch = this.bgSwatches[index];
		if (!swatch || swatch.hex === null) return false;
		const alreadyBg = bgHexEq(swatch.hex, this.canvasBg);
		if (!swatch.enabled) {
			const next = this.bgSwatches.slice();
			next[index] = { ...swatch, enabled: true };
			this.bgSwatches = next;
			this.coerceColorIndex();
		}
		if (alreadyBg) return !swatch.enabled;
		this.selectCanvasBg(swatch.hex);
		return true;
	}

	/**
	 * Toggle a swatch in/out of the rock-color pool. Order stays fixed.
	 * Never empties the rock-color pool (at least one non-bg enabled chromatic).
	 * The pinned canvas background cannot be disabled.
	 */
	toggleBgSwatch(index: number): boolean {
		const swatch = this.bgSwatches[index];
		if (!swatch || swatch.hex === null) return false;

		if (!swatch.enabled) {
			const next = this.bgSwatches.slice();
			next[index] = { ...swatch, enabled: true };
			this.bgSwatches = next;
			this.coerceColorIndex();
			return true;
		}

		// Pinned background stays enabled.
		if (bgHexEq(swatch.hex, this.canvasBg)) return false;

		const next = this.bgSwatches.slice();
		next[index] = { ...swatch, enabled: false };
		const poolAfter = next.flatMap((s) =>
			s.enabled && s.hex !== null && !isRockColorExcluded(s.hex, this.canvasBg) ? [s.hex] : []
		);
		if (poolAfter.length === 0) return false;

		this.bgSwatches = next;
		this.coerceColorIndex();
		return true;
	}

	/** Shuffle unlocked rock fills among the enabled pool (Canvas applies). */
	shuffleRockColors() {
		if (this.enabledBgRockColors.length < 1) return;
		this.skipSelectionColorApply = true;
		this.coerceColorIndex();
		queueMicrotask(() => {
			this.skipSelectionColorApply = false;
		});
		this.colorShuffleVersion++;
	}

	/**
	 * Switch palette: reset swatches (all on, fixed order). Keep canvas bg when
	 * the hex exists in the new palette; otherwise fall back to Paper.
	 */
	selectPalette(id: ColorPaletteId) {
		if (id === this.activePaletteId) return;
		this.activePaletteId = id;
		this.bgSwatches = defaultBgSwatchesFor(id);
		const bgStillValid = this.bgSwatches.some(
			(s) => s.hex !== null && bgHexEq(s.hex, this.canvasBg)
		);
		if (!bgStillValid) {
			this.canvasBg = PAPER_HEX;
			this.bgRecolor = null;
			this.canvasBgVersion++;
		}
		this.skipSelectionColorApply = true;
		this.coerceColorIndex();
		queueMicrotask(() => {
			this.skipSelectionColorApply = false;
		});
		this.paletteSwitchVersion++;
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
		this.clampStackCount();
	}

	cycleSize() {
		this.sizeIndex = (this.sizeIndex + 1) % ROCK_SIZES.length;
		this.clampStackCount();
	}

	/** Highest stack count that can place for the current aspect + size. */
	get maxStackCount(): number {
		return maxStackCountFor(this.aspect, this.sizeIndex);
	}

	clampStackCount() {
		const max = this.maxStackCount;
		if (this.stackCount > max) this.stackCount = max;
		if (this.stackCount < STACK_COUNT_MIN) this.stackCount = STACK_COUNT_MIN;
	}

	cycleStackCount() {
		const max = this.maxStackCount;
		if (max <= STACK_COUNT_MIN) {
			this.stackCount = STACK_COUNT_MIN;
			return;
		}
		this.stackCount = this.stackCount >= max ? STACK_COUNT_MIN : this.stackCount + 1;
	}

	setStackCount(n: number) {
		const max = this.maxStackCount;
		this.stackCount = Math.min(max, Math.max(STACK_COUNT_MIN, Math.round(n)));
	}

	rotateBy(degrees: number) {
		this.rotation = (this.rotation + degrees + 360) % 360;
	}

	toggleMode() {
		this.mode = this.mode === 'cluster' ? 'stack' : 'cluster';
		if (this.mode === 'stack') this.clampStackCount();
	}

	/** Alias for the lucky-panel cycle control. */
	cycleMode() {
		this.toggleMode();
	}

	setMode(mode: Mode) {
		this.mode = mode;
		if (mode === 'stack') this.clampStackCount();
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
		this.clampStackCount();
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
