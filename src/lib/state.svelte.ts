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

/** Reorderable top-bar swatch: stable key, solid fill hex, dice-pool flag.
 *  `hex` stays `string | null` for typing; the bar never inserts null. */
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
	// Leftmost = canvas bg: prefer Paper when present, else first chromatic.
	const paper = colors.find((c) => hexEq(c.hex, PAPER_HEX));
	const rest = colors.filter((c) => !hexEq(c.hex, PAPER_HEX));
	const ordered = paper ? [paper, ...rest] : colors;
	return ordered.map((p) => ({
		key: p.hex,
		hex: p.hex,
		enabled: true
	}));
}

function bgHexEq(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	return hexEq(a, b);
}

/**
 * Paper may only sit at index 0 (canvas bg, enabled) or last (deactivated).
 * Any other placement is corrected by appending Paper disabled at the end.
 */
export function normalizePaperPlacement(list: BgSwatch[]): BgSwatch[] {
	const paperIdx = list.findIndex((s) => s.hex !== null && hexEq(s.hex, PAPER_HEX));
	if (paperIdx < 0) return list;
	if (paperIdx === 0) {
		const paper = list[0]!;
		if (paper.enabled) return list;
		const next = list.slice();
		next[0] = { ...paper, enabled: true };
		return next;
	}
	const next = list.slice();
	const [paper] = next.splice(paperIdx, 1);
	if (!paper) return list;
	next.push({ ...paper, enabled: false });
	return next;
}

/** Enabled swatches first (order preserved), then disabled (order preserved). */
export function partitionBgSwatches(list: BgSwatch[]): BgSwatch[] {
	const enabled: BgSwatch[] = [];
	const disabled: BgSwatch[] = [];
	for (const s of list) {
		if (s.enabled) enabled.push(s);
		else disabled.push(s);
	}
	return normalizePaperPlacement([...enabled, ...disabled]);
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
	/** Active top-bar color palette (Warm or Cool). */
	activePaletteId: ColorPaletteId = $state('warm');
	/** Top-bar bg swatches for the active palette (leftmost = canvas background). */
	bgSwatches: BgSwatch[] = $state(defaultBgSwatchesFor('warm'));
	/** Bumped by the top-bar dice to shuffle palette order (rocks sync via colorSlot). */
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
		this.bgSwatches = normalizePaperPlacement(this.bgSwatches);
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
	toggleBgSwatch(index: number): boolean {
		const swatch = this.bgSwatches[index];
		if (!swatch) return false;
		// Paper is background-only — never toggle rock-pool enable.
		if (swatch.hex !== null && hexEq(swatch.hex, PAPER_HEX)) return false;

		if (!swatch.enabled) {
			const next = this.bgSwatches.slice();
			next[index] = { ...swatch, enabled: true };
			this.bgSwatches = partitionBgSwatches(next);
			this.coerceColorIndex();
			return true;
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
		if (poolAfter.length === 0) return false;

		this.bgSwatches = partitioned;
		if (wasLeft) {
			this.ensureLeftmostEnabled();
			this.selectCanvasBg(this.bgSwatches[0]?.hex ?? null);
		} else {
			this.coerceColorIndex();
		}
		return true;
	}

	/** Move a swatch to index 0 and select it as the canvas background. */
	moveBgSwatchToFront(index: number) {
		if (index <= 0 || index >= this.bgSwatches.length) return;
		this.reorderBgSwatch(index, 0);
	}

	/**
	 * Dice: shuffle enabled chromatic swatches only. Paper stays first+enabled
	 * if it was bg, otherwise last+disabled. Disabled chromatics stay on the right.
	 * Rocks keep a colorSlot index and Canvas syncs fills from the new order.
	 */
	shuffleRockColors() {
		const paperWasFirst =
			this.bgSwatches[0]?.hex !== null && hexEq(this.bgSwatches[0]!.hex, PAPER_HEX);
		const paper = this.bgSwatches.find((s) => s.hex !== null && hexEq(s.hex, PAPER_HEX));
		const chromatic = this.bgSwatches.filter(
			(s) => !(s.hex !== null && hexEq(s.hex, PAPER_HEX))
		);
		const enabled = chromatic.filter((s) => s.enabled);
		const disabled = chromatic.filter((s) => !s.enabled);
		if (enabled.length < 2) return;

		const prevKeys = enabled.map((s) => s.key);
		let nextEnabled = enabled.slice();
		for (let attempt = 0; attempt < 10; attempt++) {
			for (let i = nextEnabled.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const a = nextEnabled[i]!;
				nextEnabled[i] = nextEnabled[j]!;
				nextEnabled[j] = a;
			}
			if (nextEnabled.some((s, i) => s.key !== prevKeys[i])) break;
		}
		if (nextEnabled.every((s, i) => s.key === prevKeys[i])) return;

		if (paper && paperWasFirst) {
			this.bgSwatches = [{ ...paper, enabled: true }, ...nextEnabled, ...disabled];
		} else if (paper) {
			this.bgSwatches = [...nextEnabled, ...disabled, { ...paper, enabled: false }];
		} else {
			this.bgSwatches = [...nextEnabled, ...disabled];
		}
		this.ensureLeftmostEnabled();

		const newLeft = this.bgSwatches[0]?.hex ?? null;
		if (!bgHexEq(this.canvasBg, newLeft)) {
			// Slot sync owns rock recolor — skip selectCanvasBg's swap.
			this.canvasBg = newLeft;
			this.bgRecolor = null;
			this.canvasBgVersion++;
		}

		this.skipSelectionColorApply = true;
		this.coerceColorIndex();
		queueMicrotask(() => {
			this.skipSelectionColorApply = false;
		});
		this.colorShuffleVersion++;
	}

	/**
	 * Switch Warm/Cool palette: reset swatches (Paper leftmost, all on),
	 * force canvas bg to Paper, then bump paletteSwitchVersion so Canvas
	 * recolors unlocked rocks into the new pool.
	 */
	selectPalette(id: ColorPaletteId) {
		if (id === this.activePaletteId) return;
		this.activePaletteId = id;
		this.bgSwatches = defaultBgSwatchesFor(id);
		if (!bgHexEq(this.canvasBg, PAPER_HEX)) {
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
