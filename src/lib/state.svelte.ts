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

/** Colors that cycle as fills for placed rocks. */
export const ROCK_COLORS: Swatch[] = PALETTE.filter((c) => c.name !== 'Paper');

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
export type DesignMode = 'place' | 'shuffle';

export interface UploadedImage {
	id: string;
	src: string;
}

class AppState {
	designMode: DesignMode = $state('place');
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

	/** Per-item shuffle selections — only used in shuffle design mode.
	 *  Every color and shape is on by default; toggling an entry removes it
	 *  from the pool the shuffle draws from. Size uses `sizeIndex` (shared). */
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
	private imageSeq = 0;

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

	/** Hex fills currently allowed in the shuffle. */
	get enabledColors(): string[] {
		return ROCK_COLORS.filter((_, i) => this.colorEnabled[i]).map((c) => c.hex);
	}

	/** Rock indices currently allowed in the shuffle. */
	get enabledShapes(): number[] {
		return this.shapeEnabled.reduce<number[]>((acc, on, i) => {
			if (on) acc.push(i);
			return acc;
		}, []);
	}

	get nextColor(): Swatch {
		return ROCK_COLORS[this.colorIndex];
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

	toggleDesignMode() {
		this.designMode = this.designMode === 'place' ? 'shuffle' : 'place';
		if (this.designMode === 'shuffle') this.shuffleSeed++;
		else this.clear();
	}

	/** Flip one entry on/off, but never leave a category completely empty. */
	private toggleAt(flags: boolean[], i: number): boolean[] {
		const next = flags.slice();
		if (next[i] && next.filter(Boolean).length === 1) return flags;
		next[i] = !next[i];
		return next;
	}

	toggleColor(i: number) {
		this.colorEnabled = this.toggleAt(this.colorEnabled, i);
	}

	toggleShape(i: number) {
		this.shapeEnabled = this.toggleAt(this.shapeEnabled, i);
	}

	shuffle() {
		this.shuffleSeed++;
	}

	advanceColor(direction: 1 | -1 = 1) {
		this.colorIndex =
			(this.colorIndex + direction + ROCK_COLORS.length) % ROCK_COLORS.length;
	}

	selectColor(i: number) {
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
