import { create } from 'zustand'
import type { NavMessage } from '../features/chat-nav/messageIndex'

export interface ScrollView {
  scrollable: { start: boolean; end: boolean }
  /** Ids of every intersecting row (messages and note rows alike), as the scroller reports them. */
  visibleMessageIds: readonly string[]
  /** The topmost visible navigable message; `null` when none is on screen. */
  currentMessageId: string | null
}

export interface ScrollBridgeJumpOptions {
  /** Flash the target row's outline once it has landed. Defaults to true. */
  highlight?: boolean
}

/** What a mounted `Transcript` offers to anything outside its `MessageScrollerProvider`. */
export interface ScrollBridge {
  scrollToMessage(messageId: string, options?: { align?: 'start' | 'center' | 'end' | 'nearest'; scrollMargin?: number }): boolean
  scrollToStart(): boolean
  scrollToEnd(): boolean
  /** Reveals every turn `windowTranscriptTurns` hides, without restoring the "Load earlier" anchor. */
  revealEarlier(): void
  /** Reveal if windowed out, scroll, run the landing correction, detach from autoscroll, highlight.
   * Returns false when the message cannot be found. Use `jumpToMessage`, which also announces. */
  jump(messageId: string, options?: ScrollBridgeJumpOptions): boolean
  /** The row's top minus the viewport top in pixels; `null` when the row is not mounted. */
  getMessageTopOffset(messageId: string): number | null
  /** Number of turns currently hidden by the window. */
  getHiddenTurnCount(): number
}

export interface ChatNavEntry {
  index: readonly NavMessage[]
  bridge: ScrollBridge | null
  view: ScrollView
}

export const EMPTY_CHAT_NAV: ChatNavEntry = {
  index: [],
  bridge: null,
  view: { scrollable: { start: false, end: false }, visibleMessageIds: [], currentMessageId: null }
}

interface ChatNavState {
  bySession: Record<string, ChatNavEntry>
  setIndex(sessionId: string, index: readonly NavMessage[]): void
  setView(sessionId: string, view: ScrollView): void
  /** Registers the Session's bridge; the returned function unregisters it only if it is still the
   * current one (a second pane showing the same Session may have replaced it). */
  registerBridge(sessionId: string, bridge: ScrollBridge): () => void
}

function entryOf(state: ChatNavState, sessionId: string): ChatNavEntry {
  return state.bySession[sessionId] ?? EMPTY_CHAT_NAV
}

export const useChatNavStore = create<ChatNavState>((set, get) => ({
  bySession: {},
  setIndex: (sessionId, index) =>
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...entryOf(state, sessionId), index } } })),
  setView: (sessionId, view) =>
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...entryOf(state, sessionId), view } } })),
  registerBridge: (sessionId, bridge) => {
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { ...entryOf(state, sessionId), bridge } } }))
    return () => {
      const current = get().bySession[sessionId]
      if (!current || current.bridge !== bridge) return
      set((state) => {
        const { [sessionId]: _removed, ...rest } = state.bySession
        return { bySession: rest }
      })
    }
  }
}))
