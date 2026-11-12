import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Issue #510 (PLAN.md row A0): the repo had no TypeScript test runner before this story (noted
// as a known gap in #488's own PR, "the first thing to test once one exists"). Originally scoped
// to `node` to cover the main-process-only `terminationDetection.ts` (since ported to Rust and
// deleted along with the rest of `src/main` at #796/R13); every test added since has stayed pure
// renderer/shared logic (`src/renderer/**`, `src/shared/**`) -- no jsdom/browser environment
// needed either way.
export default defineConfig({
  // Mirrors the `@/*` path in tsconfig.web.json so renderer modules that import `@/state` resolve.
  resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) } },
  test: {
    environment: 'node',
    // The `scripts/` entries are the script helpers' vitest suites; other scripts/*.test.mjs use node:test.
    include: [
      'src/**/*.test.ts',
      'scripts/check-parity.test.mjs',
      'scripts/check-drag-regions.test.mjs',
      'scripts/release-changelog.test.mjs',
      'scripts/theme-tokens.test.mjs',
      'scripts/token-guard-probe/ab.test.mjs',
      'scripts/token-guard-probe/cli.test.mjs',
      'scripts/token-guard-probe/groups/helpers.test.mjs',
      'scripts/token-guard-probe/observe.test.mjs',
    ],
  },
});
