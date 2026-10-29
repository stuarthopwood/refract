/** Issue #1300 (Settings, Appearance "Chat row spacing"): the gap between two consecutive
 * bookkeeping rows in the transcript (docs/DESIGN.md "Transcript rhythm"). Tight 4px, Compact 8px
 * (the default), Comfy 16px, all on the #1252 grid. Class names are written out in full so
 * Tailwind keeps them. */
export type ChatRowDensity = 'tight' | 'compact' | 'comfy'

export const DEFAULT_CHAT_ROW_DENSITY: ChatRowDensity = 'compact'

export const CHAT_ROW_GAP_CLASS: Record<ChatRowDensity, string> = {
  tight: 'mt-1',
  compact: 'mt-2',
  comfy: 'mt-4'
}
