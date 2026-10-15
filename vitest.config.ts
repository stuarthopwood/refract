import { defineConfig } from 'vitest/config';

// Issue #510 (PLAN.md row A0): the repo had no TypeScript test runner before this story (noted
// as a known gap in #488's own PR, "the first thing to test once one exists"). Originally scoped
// to `node` to cover the main-process-only `terminationDetection.ts` (since ported to Rust and
// deleted along with the rest of `src/main` at #796/R13); every test added since has stayed pure
// renderer/shared logic (`src/renderer/**`, `src/shared/**`) -- no jsdom/browser environment
// needed either way.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
