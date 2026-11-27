// Dark (high contrast) floors, #552 decision: text at 7:1, every edge and divider at 4.5:1 with soft dividers off.
// Spread into PAIRS (theme-contrast-pairs.mjs); each row is scoped to this one preset, so the shared 3:1/4.5:1 rows still apply to the rest.

import { DARK_HIGH_CONTRAST_THEMES } from './theme-groups.mjs'

const onlyThemes = DARK_HIGH_CONTRAST_THEMES

// Surfaces body text can sit on. `muted` is the hover/selected fill, the binding (lightest) one.
const TEXT_SURFACES = ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-right', 'composer-background']

const textRows = (fg, surfaces) => surfaces.map((bg) => ({ fg, bg, min: 7, onlyThemes }))
const edgeRows = (fg, surfaces) => surfaces.map((bg) => ({ fg, bg, min: 4.5, onlyThemes }))

export const DARK_HC_PAIRS = [
  ...textRows('foreground', TEXT_SURFACES),
  ...textRows('muted-foreground', TEXT_SURFACES),
  ...textRows('chat-foreground', ['background', 'card']),
  ...textRows('card-foreground', ['card']),
  ...textRows('popover-foreground', ['popover']),
  ...textRows('sidebar-foreground', ['sidebar', 'sidebar-accent']),
  ...textRows('muted-foreground', ['sidebar-accent', 'sidebar-border']),
  ...textRows('foreground', ['sidebar-border']),
  // Colour-coded glyphs and text keep their hues (#552 option a) but reach the same 7:1 on the plain surfaces.
  ...['accent-text', 'severity-success', 'severity-warning', 'severity-error', 'severity-info'].flatMap((fg) =>
    textRows(fg, ['background', 'card', 'popover']),
  ),
  // Edges: `--divider` and `--border-strong` alias `--border` here (soft dividers off), so they are enforced too.
  ...['border', 'divider', 'border-strong'].flatMap((fg) =>
    edgeRows(fg, ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-right', 'titlebar', 'composer-background']),
  ),
  ...edgeRows('input', ['background', 'card', 'popover', 'muted']),
  ...edgeRows('ring', ['background', 'card', 'popover', 'muted', 'sidebar', 'sidebar-accent', 'accent', 'composer-background']),
  ...edgeRows('composer-border', ['background', 'composer-background']),
  ...edgeRows('composer-control-border', ['background', 'composer-background']),
  ...edgeRows('composer-focus', ['background', 'composer-background']),
  ...edgeRows('field-border', ['background', 'card', 'popover']),
  ...edgeRows('ghost-edge', ['background', 'card', 'popover']),
  ...edgeRows('pane-focused-edge', ['background']),
]
