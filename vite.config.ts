import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the build works when served from a GitHub Pages subpath.
  base: './',
  plugins: [svelte()],
})
