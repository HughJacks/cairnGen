# cairnGen

A generator tool for building clusters and stacked rock shapes ("cairns") from a set of rock SVGs, using Svelte 5 and Paper.js.

## Current features

- **Place mode** (default): manually place rocks with snap-to-contact rules, rotation, and size controls.
- **Shuffle mode**: auto-generate compositions using the same snap rules. Choose aspect ratio, cluster vs stack generation, and toggle colors, shapes, and sizes on or off. Hit **Shuffle** to regenerate.
  - **Cluster shuffle**: grows a single cohesive cluster outward from the canvas center, keeping every rock as close to the middle as the snap rules allow.
  - **Stack shuffle**: creates multiple balanced stacks packed toward the horizontal center.
- Toggle between place and shuffle via the leftmost toolbar button (crosshair ↔ shuffle arrows).

In **place mode**:
- **Cluster** — rocks snap to touch other rocks; may run off canvas edges.
- **Stack** — rocks rest on the ground or on top of each other, balanced near the stack's center-of-mass line.
- Ghost preview only appears at genuinely placeable spots; gray hint follows the cursor elsewhere.

## Development

```bash
npm install
npm run dev
```

Then open the printed localhost URL.

Other scripts:

- `npm run build` – production build to `dist/`
- `npm run check` – svelte-check + TypeScript type checking

## Structure

- `svgs/` – original source rock SVGs
- `src/assets/rocks/` – rock SVGs bundled into the app (imported as raw strings for Paper.js)
- `src/lib/state.svelte.ts` – shared runes state (aspect ratio, active rock, palette cycle)
- `src/lib/Toolbar.svelte` – floating toolbar (place + shuffle controls)
- `src/lib/shuffle.ts` – auto-generation using snap rules
- `src/lib/Canvas.svelte` – Paper.js stage
