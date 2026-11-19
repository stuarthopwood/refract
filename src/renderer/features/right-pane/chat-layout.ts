// Spec 137 FR-017, FR-018, FR-024, FR-034 (#2075): the pure rules App.tsx's center/right layout
// follows while the chat panel collapses to zero width, so they are testable without a DOM.
import type { MainView } from '@/state/view-store'
import { effectiveChatCollapsed } from './toggle-chat-pane'

/** Two Chat panes need 360 px each (the panels' `minSize`). */
export const MIN_SPLIT_WIDTH_PX = 360 * 2

/** A width-0 report comes from the collapsed panel, not from a narrow window: keep the last real width (FR-017). */
export function nextChatWidth(prev: number | null, sizePx: number): number | null {
  return sizePx > 0 ? sizePx : prev
}

export function canShowSplit(chatWidthPx: number | null): boolean {
  return chatWidthPx !== null && chatWidthPx >= MIN_SPLIT_WIDTH_PX
}

/** Holds the last real width while the panel is at 0, so the transcript does not re-wrap and lose its scroll position (SC-004). */
export function heldChatContentWidth(input: { chatHidden: boolean; panelCollapsed: boolean; lastWidthPx: number | null }): number | undefined {
  return (input.chatHidden || input.panelCollapsed) && input.lastWidthPx !== null ? input.lastWidthPx : undefined
}

/** The Sessions the main process keeps visible; hiding chat never shrinks this set, so none goes Unread (FR-034). */
export function visibleSessionIds(input: { paneSessionIds: readonly string[]; splitFits: boolean; frontSessionId: string | null }): string[] {
  if (input.paneSessionIds.length === 2 && input.splitFits) return [...input.paneSessionIds]
  return input.frontSessionId ? [input.frontSessionId] : []
}

export type ChatPanelResizeAction = 'none' | 'hide' | 'show' | 'restore'

/**
 * What a size report of the chat panel means for the stored state. Our own collapse and expand arrive
 * after the store already agrees, so only a drag (or a narrow window) differs from it: a drag to zero
 * hides chat when the right pane is open, and otherwise the panel is restored so both are never hidden (FR-018).
 */
export function chatPanelResizeAction(input: {
  sizePx: number
  prevSizePx: number | undefined
  view: MainView
  open: boolean
  chatCollapsed: boolean
}): ChatPanelResizeAction {
  if (input.prevSizePx === undefined) return 'none'
  const collapsed = input.sizePx <= 0
  if (collapsed === input.prevSizePx <= 0) return 'none'
  if (collapsed) {
    if (effectiveChatCollapsed(input.chatCollapsed, input.view)) return 'none'
    return input.view === 'chat' && input.open ? 'hide' : 'restore'
  }
  return effectiveChatCollapsed(input.chatCollapsed, input.view) ? 'show' : 'none'
}

/** The width the right pane gained from a chat collapse is not a width the user chose (FR-024). */
export function rightWidthToSync(sizePx: number, chatHidden: boolean): number | null {
  return sizePx > 0 && !chatHidden ? sizePx : null
}
