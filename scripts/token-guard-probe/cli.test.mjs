import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertScratchRootSafe, formatLine, parseArgs, selectGroups } from './cli.mjs';

describe('parseArgs', () => {
  it('defaults to two runs and no filters', () => {
    expect(parseArgs([])).toEqual({ out: null, groups: [], runs: 2, scratchRoot: null });
  });

  it('accepts the pnpm `--` separator, --out, repeated and comma --group, --runs and --scratch-root', () => {
    const a = parseArgs(['--', '--out', 'r.json', '--group', 'tools,prompt', '--group', 'idle', '--runs', '3', '--scratch-root', 'S']);
    expect(a).toEqual({ out: 'r.json', groups: ['tools', 'prompt', 'idle'], runs: 3, scratchRoot: 'S' });
  });

  it('rejects unknown flags, missing values and bad --runs', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--out', '--group'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--runs', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--runs', 'x'])).toThrow(/positive integer/);
  });
});

describe('assertScratchRootSafe', () => {
  // path.resolve only understands the host's path syntax: on Linux `C:\Users\u` is one relative segment, so
  // fixtures are built per platform to keep the same overlap/disjoint shapes on both.
  const onWindows = process.platform === 'win32';
  const home = onWindows ? 'C:\\Users\\u' : '/home/u';
  const at = (...segments) => path.join(home, ...segments);
  const real = [at('.omp'), at('.pi'), at('AppData', 'Roaming', 'refract-tauri')];
  const otherRoot = onWindows ? 'D:\\scratch' : '/mnt/scratch';

  it('accepts a root disjoint from the real dirs', () => {
    expect(() => assertScratchRootSafe(at('refract-1935-probe'), real)).not.toThrow();
  });

  it('refuses a root equal to, inside, or containing a real dir', () => {
    expect(() => assertScratchRootSafe(at('.omp'), real)).toThrow(/overlaps/);
    expect(() => assertScratchRootSafe(at('.pi', 'scratch'), real)).toThrow(/overlaps/);
    expect(() => assertScratchRootSafe(home, real)).toThrow(/overlaps/);
    expect(() => assertScratchRootSafe(path.join(home.toUpperCase(), 'APPDATA', 'roaming', 'Refract-Tauri'), real)).toThrow(/overlaps/);
  });

  it('does not treat a sibling sharing a name prefix as overlapping', () => {
    expect(() => assertScratchRootSafe(at('.omp2'), real)).not.toThrow();
  });

  it('refuses a trailing separator on a real dir root', () => {
    expect(() => assertScratchRootSafe(`${at('.omp')}${path.sep}`, real)).toThrow(/overlaps/);
  });

  it('allows a root outside the real dirs tree (another drive on Windows)', () => {
    expect(() => assertScratchRootSafe(path.join(otherRoot, 'refract-1935-probe'), real)).not.toThrow();
  });

  it('refuses a child literally named `..foo` inside a real dir', () => {
    expect(() => assertScratchRootSafe(at('.omp', '..foo'), real)).toThrow(/overlaps/);
  });
});

describe('selectGroups', () => {
  const groups = { smoke: { smoke: true }, tools: {}, idle: {} };

  it('selects every non-smoke group by default', () => {
    expect(selectGroups(groups, [])).toEqual(['tools', 'idle']);
  });

  it('selects named groups, including smoke, once each', () => {
    expect(selectGroups(groups, ['smoke', 'tools', 'smoke'])).toEqual(['smoke', 'tools']);
  });

  it('throws on an unknown group and lists the known ones', () => {
    expect(() => selectGroups(groups, ['nope'])).toThrow(/unknown group nope; known: smoke, tools, idle/);
  });
});

describe('formatLine', () => {
  it('prints key, verdict, observable and the last run control/test pairs', () => {
    const line = formatLine({
      key: 'grep.contextBefore',
      verdict: 'live',
      observable: 'tool-result text',
      runs: [
        { control: { before: 1, after: 1 }, test: { before: 1, after: 1 } },
        { control: { before: 'a', after: 'a' }, test: { before: 'a', after: 'b' } },
      ],
    });
    expect(line).toBe('grep.contextBefore\tlive\ttool-result text\tcontrol "a"->"a"\ttest "a"->"b"');
  });

  it('does not throw when no run recorded anything', () => {
    expect(formatLine({ key: 'k', verdict: 'inconclusive-startup-only', observable: 'o', runs: [] })).toContain('control undefined->undefined');
  });
});
