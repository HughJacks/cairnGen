declare module 'poly-decomp' {
	const decomp: {
		decomp: (vertices: number[][]) => number[][][];
		quickDecomp: (vertices: number[][]) => number[][][];
		isSimple: (vertices: number[][]) => boolean;
		removeCollinearPoints: (vertices: number[][], threshold: number) => number;
		removeDuplicatePoints: (vertices: number[][], threshold: number) => void;
		makeCCW: (vertices: number[][]) => void;
	};
	export default decomp;
}
