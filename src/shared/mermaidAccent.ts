import type { ThemeId } from './themes'

// #456: each preset's Mermaid accent, the same source as its Markdown tokens. `accent` is the
// preset's own `--accent-text` value in globals.css (keep them in step); `fill` is that accent at 8% over the node surface (a faint tint, labels stay in the
// prose colour). Dark (high contrast)'s `--accent-text` is `oklch(0.75 0.17 264)`, written as hex.
export const MERMAID_ACCENTS: Record<ThemeId, { accent: string; fill: string }> = {
  dark: { accent: '#7375F2', fill: '#2d2e52' },
  obsidian: { accent: '#8588F4', fill: '#303255' },
  'dark-high-contrast': { accent: '#76a9ff', fill: '#233451' },
  'nordic-frost': { accent: '#1ad1d1', fill: '#11464c' },
  'cyber-amber': { accent: '#fb923c', fill: '#553522' }
}
