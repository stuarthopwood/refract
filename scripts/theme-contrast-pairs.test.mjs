import { describe, expect, it } from 'vitest';
import { DARK_HC_PAIRS } from './dark-hc-contrast-pairs.mjs';
import { PAIRS } from './theme-contrast-pairs.mjs';

// Written out independently of dark-hc-contrast-pairs.mjs: dropping or loosening a foreground x surface row must fail here.
const HC_TABLE = [
  [7, 'foreground', ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-right', 'composer-background', 'sidebar-border']],
  [7, 'muted-foreground', ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-right', 'composer-background', 'sidebar-accent', 'sidebar-border']],
  [7, 'chat-foreground', ['background', 'card']],
  [7, 'card-foreground', ['card']],
  [7, 'popover-foreground', ['popover']],
  [7, 'sidebar-foreground', ['sidebar', 'sidebar-accent']],
  ...['accent-text', 'severity-success', 'severity-warning', 'severity-error', 'severity-info'].map((fg) => [7, fg, ['background', 'card', 'popover']]),
  ...['border', 'divider', 'border-strong'].map((fg) => [4.5, fg, ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-right', 'titlebar', 'composer-background']]),
  [4.5, 'input', ['background', 'card', 'popover', 'muted']],
  [4.5, 'ring', ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-accent', 'accent', 'composer-background']],
  [4.5, 'sidebar-ring', ['sidebar', 'sidebar-accent']],
  [4.5, 'composer-ring', ['background', 'composer-background']],
  [4.5, 'composer-border', ['background', 'composer-background']],
  [4.5, 'composer-control-border', ['background', 'composer-background']],
  [4.5, 'composer-focus', ['background', 'composer-background']],
  [4.5, 'field-border', ['background', 'card', 'popover']],
  [4.5, 'ghost-edge', ['background', 'card', 'popover']],
  [4.5, 'pane-focused-edge', ['background']],
];

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

describe('dark high contrast pair table', () => {
  const key = ({ fg, bg, min }) => `${fg}|${bg}|${min}`;
  const expected = HC_TABLE.flatMap(([min, fg, surfaces]) => surfaces.map((bg) => key({ fg, bg, min }))).sort();

  it('holds_exactly_the_expected_fg_by_surface_rows_at_the_right_minimum', () => {
    expect(expected).toHaveLength(91);
    expect(DARK_HC_PAIRS.map(key).sort()).toEqual(expected);
  });

  it('feeds_every_row_into_PAIRS_scoped_to_dark_high_contrast_only', () => {
    for (const row of DARK_HC_PAIRS) {
      const merged = PAIRS.find((pair) => key(pair) === key(row) && pair.onlyThemes?.join() === 'dark-high-contrast');
      expect(merged, key(row)).toBeDefined();
    }
  });
});
