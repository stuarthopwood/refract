import { describe, expect, it } from 'vitest';
import { PAIRS } from './theme-contrast-pairs.mjs';

const onRightPane = (fg) => PAIRS.filter((pair) => pair.fg === fg && pair.bg === 'sidebar-right');

describe('theme contrast pairs', () => {
  it('pairs_include_checklist_tokens', () => {
    expect(onRightPane('severity-success').map((p) => p.min)).toEqual([4.5]);
    expect(onRightPane('state-working').map((p) => p.min)).toEqual([4.5]);
    expect(onRightPane('severity-warning').map((p) => p.min)).toEqual([4.5]);
    expect(onRightPane('ring').map((p) => p.min)).toEqual([3]);
  });
});
