# cairnGen

A generator tool for building clusters and stacked rock shapes ("cairns") from a set of rock SVGs, using Svelte 5 and Paper.js.

## Current features

- **Place mode** (default): manually place rocks with snap-to-contact rules, rotation, and size controls.
- **Shuffle mode**: auto-generate compositions using the same snap rules. Choose aspect ratio, cluster vs stack generation, and toggle colors, shapes, and sizes on or off. Hit **Shuffle** to regenerate.
  - **Cluster shuffle**: grows a single cohesive cluster outward from the canvas center, keeping every rock as close to the middle as the snap rules allow.
  - **Stack shuffle**: creates multiple balanced stacks packed toward the horizontal center.
- Toggle between place and shuffle via the leftmost toolbar button (crosshair ↔ shuffle arrows).

In **place mode**:
- Click empty canvas to drop rocks; click a shape to select it, then change its color from the palette. Drag to move or scroll over a selected shape to rotate — all using the same snap rules as placement. Press **Delete** or **Backspace** to remove the selected shape.
- **Images** — upload to the bank, hover a thumbnail and click **Edit** to enter image edit mode: the canvas dims, click shapes to mask the image, drag to pan and scroll to zoom inside a mask. Use **Mask all** to fill every shape, then **✓** to save or **✕** to cancel.
- **Cluster** — rocks may be placed anywhere (no overlap); nearby rocks snap together. May run off canvas edges.
- **Stack** — rocks rest on the ground or on top of each other, balanced near the stack's center-of-mass line.

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
