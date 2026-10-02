import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Minified so JSDoc traceability comments (ticket/requirement numbers) never ship in the
  // built bundle: scripts/check-ui-text.mjs scans out/main and out/preload for exactly that leak.
  main: { build: { minify: true } },
  preload: { build: { minify: true } },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
