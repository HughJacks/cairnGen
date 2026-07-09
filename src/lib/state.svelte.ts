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

import { ROCK_COUNT } from './rocks';

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
	private imageSeq = 0;

	/** Rock colors shown in pickers / used by shuffle for the current background. */
	get availableRockColors(): Swatch[] {
		return rockColorsForUi(this.canvasBg);
	}

	/** True when this ROCK_COLORS index is usable with the current background. */
	isRockColorAvailable(i: number): boolean {
		const swatch = ROCK_COLORS[i];
		return !!swatch && !isRockColorExcluded(swatch.hex, this.canvasBg);
	}

	/** If colorIndex points at an excluded swatch, move it to the first available. */
	private coerceColorIndex() {
		const available = this.availableRockColors;
		if (!available.length) return;
		const current = ROCK_COLORS[this.colorIndex];
		if (current && !isRockColorExcluded(current.hex, this.canvasBg)) return;
		const next = rockColorIndex(available[0].hex);
		if (next >= 0) this.colorIndex = next;
	}

	/** Keep at least one available lucky-color toggle on after a bg change. */
	private coerceColorEnabled() {
		const availableIdx = ROCK_COLORS.flatMap((c, i) =>
			isRockColorExcluded(c.hex, this.canvasBg) ? [] : [i]
		);
		if (!availableIdx.length) return;
		if (availableIdx.some((i) => this.colorEnabled[i])) return;
		const next = this.colorEnabled.slice();
		next[availableIdx[0]] = true;
		this.colorEnabled = next;
	}

	selectCanvasBg(hex: string | null) {
		if (hex === this.canvasBg || (hex !== null && this.canvasBg !== null && hexEq(hex, this.canvasBg))) {
			return;
		}
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
		this.coerceColorEnabled();
		// Effects flush before this microtask, so selection recolor can see the flag.
		queueMicrotask(() => {
			this.skipSelectionColorApply = false;
		});
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

	/** Hex fills currently allowed in the shuffle (never the active bg / banned white). */
	get enabledColors(): string[] {
		const colors = ROCK_COLORS.filter(
			(c, i) => this.colorEnabled[i] && !isRockColorExcluded(c.hex, this.canvasBg)
		).map((c) => c.hex);
		if (colors.length) return colors;
		return this.availableRockColors.map((c) => c.hex);
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
		if (current && !isRockColorExcluded(current.hex, this.canvasBg)) return current;
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
