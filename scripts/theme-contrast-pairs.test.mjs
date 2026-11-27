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

  it('dark_high_contrast_pairs_hold_text_to_7_and_edges_to_4_5_for_that_theme_only', () => {
    const hc = PAIRS.filter((p) => p.onlyThemes && p.onlyThemes.length === 1 && p.onlyThemes[0] === 'dark-high-contrast');
    const min = (fg, bg) => hc.find((p) => p.fg === fg && p.bg === bg)?.min;
    expect(min('foreground', 'muted')).toBe(7);
    expect(min('muted-foreground', 'sidebar-border')).toBe(7);
    expect(min('severity-error', 'card')).toBe(7);
    expect(min('border', 'muted')).toBe(4.5);
    expect(min('divider', 'background')).toBe(4.5);
    expect(min('input', 'background')).toBe(4.5);
    expect(min('ring', 'muted')).toBe(4.5);
  });
});
