// The pure half of `scripts/test-fast.mjs`, kept apart from the CLI so tests can import it: the CLI file
// starts with a shebang, which Vite's module runner breaks on when a Windows checkout gives it CRLF endings.

// `--passWithNoTests`: a change that touches no test-covered module is not a failure. Every later step
// must stay a verbatim `run:` of pr-fast.yml (test-fast.test.mjs enforces it); `check:ui-text` is the
// one cargo-free check left out, because it scans the bundle that a Tauri build writes.
export const STEPS = [
  'pnpm exec vitest run --changed origin/main --passWithNoTests',
  'pnpm check:indent',
  'pnpm check:theme-contrast',
  'pnpm check:theme-ids',
  'pnpm check:drag-regions',
  'pnpm check:parity -- --gate',
  'pnpm check:file-size',
  'pnpm check:comment-density',
  'pnpm check:spacing',
  'pnpm check:alpha-modifiers',
  'pnpm check:icon-only-controls',
  'pnpm check:literal-colours',
  'pnpm check:hit-targets',
  'pnpm check:advisor-roster',
  'pnpm check:versions',
  'pnpm check:omp-schema -- --check-pin',
  'pnpm check:omp-schema -- --self-test',
];

// `vitest --changed origin/main` diffs against a ref a fresh clone or worktree may not have fetched; without
// this guard git's own error is buried in vitest output.
export function originMainProblem(run, cwd) {
  const result = run('git', ['rev-parse', '--verify', 'origin/main'], { cwd, stdio: 'ignore' });
  if (result.status === 0) {
    return null;
  }
  return 'test:fast: `origin/main` was not found; run `git fetch origin main` and try again.';
}
