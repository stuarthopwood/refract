// How a width choice reads in the "Right pane width" menus. A Split needs two 360 px chat panes, so a width
// that leaves chat less than that shows one chat; the menu says so before the user picks it (spec 137 FR-017).
import { MIN_SPLIT_WIDTH_PX } from './chat-layout'
import type { PaneLayoutWidths } from './pane-width-model'

/** True when `widthPx` leaves chat too narrow for two panes. Unknown layouts never warn on a guess. */
export function widthShowsOneChat(input: { widthPx: number; isSplit: boolean; layout: PaneLayoutWidths | null }): boolean {
  if (!input.isSplit || input.layout === null) return false
  return input.layout.groupWidthPx - input.layout.sessionListPx - input.widthPx < MIN_SPLIT_WIDTH_PX
}

export function choiceText(input: { label: string; widthPx: number; shownAsOneChat: boolean }): string {
  return `${input.label} (${input.widthPx} px)${input.shownAsOneChat ? ' (shows one chat)' : ''}`
}
