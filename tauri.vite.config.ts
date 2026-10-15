import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Vite config for the Tauri/Rust build (spec 016, issue #780), the only build since Electron
// was deleted at #796/R13.
//
// `root` is left at the repository root (default) rather than `tauri/`: this build's HTML entry
// (`tauri/index.html`) references a sibling directory (`src/tauri-bridge/`) outside its own
// folder; Vite's HTML-relative-URL rewriting always resolves against `root`, so a non-default
// root here would make that sibling unreachable by a relative script `src`. Keeping the default
// root instead makes every path in the repo addressable from "/", exactly like
// `tauri.conf.json`'s own `build.devUrl`/`frontendDist` already assume.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer')
    }
  },
  plugins: [react(), tailwindcss()],
  // `tauri.conf.json`'s own `build.devUrl` targets this exact port and path; `strictPort` so a
  // silently different port never leaves the Tauri window loading nothing. `watch.ignored`
  // excludes `src-tauri/target` (and its own build output `out/tauri-web`): with `root` left at
  // the repository root (see above), Vite's default watcher would otherwise also watch `cargo`'s
  // own build artifacts under `src-tauri/target/debug/deps/*.dll`; `cargo run`'s linker opens
  // that file exclusively while writing it, so Vite's `fs.watch` call on the same file races it
  // and crashes the whole `beforeDevCommand` with `EBUSY: resource busy or locked` the moment a
  // rebuild lands mid-link (observed live running `pnpm dev` -- `dev:tauri` at the time this was
  // observed, renamed when Tauri was promoted to the main build; tasks.md T030).
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**', '**/out/tauri-web/**']
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/tauri-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'tauri/index.html')
    }
  }
})
