# cairnGen

A generator tool for building clusters and stacked rock shapes ("cairns") from a set of rock SVGs, using Svelte 5 and Paper.js.

## Current features

- Two placement modes, toggled from the toolbar:
  - **Cluster** — rocks snap to touch other rocks (the first rock can go anywhere) and may run off the canvas edges. Borders are not snap targets.
  - **Stack** — rocks stay inside the artboard and rest on the ground (bottom border) or on top of other rocks. Each stack has a center-of-mass line (dashed while hovering); new rocks must sit close to it, keeping stacks looking balanced. Off-balance spots show a red line and can't be placed.
- Click the canvas to place the active rock shape. A translucent preview appears only when the cursor is at a genuinely placeable spot — snapped to touch the nearest edge(s), still under the cursor — with a dot marking each contact point. Anywhere else the canvas stays quiet and clicks do nothing.
- A semi-transparent ghost preview follows the cursor, tinted with the upcoming fill color.
- Fill colors cycle automatically through the Project Everyone palette as you place rocks.
- Cycle through the 8 rock shapes with the scroll wheel (over the canvas), Left/Right arrow keys, or by clicking a thumbnail in the sidebar.
- Choose the artboard aspect ratio (1:1, 4:5, 5:4, 16:9, 9:16) from the sidebar.

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
- `src/lib/Sidebar.svelte` – aspect ratio selector, palette strip, rock picker
- `src/lib/Canvas.svelte` – Paper.js stage: SVG import, ghost preview, click-to-place
