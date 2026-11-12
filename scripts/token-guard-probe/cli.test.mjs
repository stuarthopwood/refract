import { describe, expect, it } from 'vitest';
import { formatLine, parseArgs, selectGroups } from './cli.mjs';

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
