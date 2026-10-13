import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Separate Vite config for the EXPERIMENTAL Tauri/Rust build (spec 016, issue #780) -- entirely
// independent of `electron.vite.config.ts`, which keeps driving the Electron build unchanged.
// Same aliases/plugins as `electron.vite.config.ts`'s own `renderer` section, so `src/renderer`
// (untouched) resolves identically under either config.
//
// `root` is left at the repository root (default) rather than `tauri/` -- unlike
// `electron.vite.config.ts`'s renderer root (`src/renderer`, which is entirely self-contained),
// this build's HTML entry (`tauri/index.html`) references a sibling directory
// (`src/tauri-bridge/`) outside its own folder; Vite's HTML-relative-URL rewriting always
// resolves against `root`, so a non-default root here would make that sibling unreachable by a
// relative script `src`. Keeping the default root instead makes every path in the repo
// addressable from "/", exactly like `tauri.conf.json`'s own `build.devUrl`/`frontendDist`
// already assume.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer')
    }
  },
  plugins: [react(), tailwindcss()],
  // `tauri.conf.json`'s own `build.devUrl` targets this exact port and path; `strictPort` so a
  // silently different port never leaves the Tauri window loading nothing.
  server: {
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'out/tauri-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'tauri/index.html')
    }
  }
})
