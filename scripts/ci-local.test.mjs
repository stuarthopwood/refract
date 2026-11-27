import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { formatStepList, parseSteps, printListIfRequested } from './ci-local-steps.mjs';

const WORKFLOW = new URL('../.github/ci-local.yml', import.meta.url);

const yamlWith = (stepLines) => `jobs:\n  build:\n    steps:\n${stepLines}\n`;

describe('parseSteps', () => {
  it('keeps run steps in order and skips uses steps', () => {
    const steps = parseSteps(
      yamlWith(
        [
          '      - uses: actions/checkout@v4',
          '      - name: Typecheck',
          '        run: pnpm typecheck',
          '      - run: pnpm test',
        ].join('\n'),
      ),
    );
    expect(steps).toEqual([
      { job: 'build', name: 'Typecheck', run: 'pnpm typecheck' },
      { job: 'build', name: 'pnpm test', run: 'pnpm test' },
    ]);
  });

  it('rejects an unknown step key that would change execution semantics', () => {
    const raw = yamlWith('      - name: Gated\n        if: always()\n        run: pnpm test');
    expect(() => parseSteps(raw)).toThrow(/"if:" key ci-local\.mjs does not understand/);
  });

  it('rejects an unknown job key', () => {
    const raw = 'jobs:\n  build:\n    strategy: {}\n    steps:\n      - run: pnpm test\n';
    expect(() => parseSteps(raw)).toThrow(/job "build" has a "strategy:" key/);
  });

  it('rejects a multi-line run', () => {
    const raw = yamlWith('      - name: Two\n        run: |\n          pnpm a\n          pnpm b');
    expect(() => parseSteps(raw)).toThrow(/multi-line "run:"/);
  });

  it('rejects a GitHub Actions expression in a run', () => {
    const raw = yamlWith("      - name: Expr\n        run: echo ${{ github.sha }}");
    expect(() => parseSteps(raw)).toThrow(/Actions expression/);
  });

  it('rejects a file with no jobs map, no run steps, or invalid YAML', () => {
    expect(() => parseSteps('name: x\n')).toThrow(/no top-level "jobs" map/);
    expect(() => parseSteps(yamlWith('      - uses: actions/checkout@v4'))).toThrow(/no steps with a "run:"/);
    expect(() => parseSteps('jobs: [')).toThrow(/failed to parse/);
  });
});

describe('.github/ci-local.yml', () => {
  it('loads under the strict parser and includes the cargo-free checks', () => {
    const runs = parseSteps(readFileSync(WORKFLOW, 'utf8')).map((step) => step.run);
    expect(runs).toContain('pnpm typecheck');
    expect(runs).toContain('pnpm check:advisor-roster');
    expect(runs.some((run) => run.startsWith('cargo test'))).toBe(true);
  });
});

describe('printListIfRequested', () => {
  const steps = parseSteps(readFileSync(WORKFLOW, 'utf8'));

  it('prints every step as a numbered line and reports it handled', () => {
    const log = vi.fn();

    expect(printListIfRequested(['node', 'ci-local.mjs', '--list'], steps, log)).toBe(true);

    expect(log.mock.calls.map(([line]) => line)).toEqual(formatStepList(steps));
    expect(log.mock.calls[0][0]).toBe(' 1. Install dependencies :: pnpm install --frozen-lockfile');
  });

  it('does nothing without --list so the caller goes on to run the steps', () => {
    const log = vi.fn();

    expect(printListIfRequested(['node', 'ci-local.mjs'], steps, log)).toBe(false);

    expect(log).not.toHaveBeenCalled();
  });
});
