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
export const ROCK_COLORS: Swatch[] = PALETTE.filter(
	(c) => c.name !== 'Ink' && c.name !== 'Paper'
);

export const ROCK_COUNT = 8;

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

class AppState {
	mode: Mode = $state('cluster');
	aspect: AspectId = $state('4:5');
	rockIndex = $state(0);
	colorIndex = $state(0);
	placedCount = $state(0);
	sizeIndex = $state(1);
	rotation = $state(0);

	get nextColor(): Swatch {
		return ROCK_COLORS[this.colorIndex];
	}

	get rockSize(): RockSize {
		return ROCK_SIZES[this.sizeIndex];
	}

	cycleRock(direction: 1 | -1) {
		this.rockIndex = (this.rockIndex + direction + ROCK_COUNT) % ROCK_COUNT;
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

	advanceColor(direction: 1 | -1 = 1) {
		this.colorIndex =
			(this.colorIndex + direction + ROCK_COLORS.length) % ROCK_COLORS.length;
	}
}

export const app = new AppState();
