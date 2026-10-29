import { create } from 'zustand'

export interface ChatFindEntry {
  open: boolean
  /** The last query, kept after the bar closes until the app closes. */
  query: string
  matchCase: boolean
  /** Bumped when Find is invoked while the bar is already open, so it re-focuses its input. */
  focusTick: number
  /** Where focus goes when the bar closes; `null` means "whatever held focus when it opened". */
  returnFocus: HTMLElement | null
}

export const EMPTY_CHAT_FIND: ChatFindEntry = { open: false, query: '', matchCase: false, focusTick: 0, returnFocus: null }

interface ChatFindState {
  bySession: Record<string, ChatFindEntry>
  open(sessionId: string, returnFocus?: HTMLElement | null): void
  close(sessionId: string): void
  setQuery(sessionId: string, query: string): void
  setMatchCase(sessionId: string, matchCase: boolean): void
}

function patch(state: ChatFindState, sessionId: string, change: Partial<ChatFindEntry>): Pick<ChatFindState, 'bySession'> {
  return { bySession: { ...state.bySession, [sessionId]: { ...(state.bySession[sessionId] ?? EMPTY_CHAT_FIND), ...change } } }
}

/** Per-Session chat search state (one search bar per pane). In memory only, so the last query
 * survives closing the bar and switching Sessions but not an app restart. */
export const useChatFindStore = create<ChatFindState>((set) => ({
  bySession: {},
  open: (sessionId, returnFocus = null) =>
    set((state) => {
      const entry = state.bySession[sessionId] ?? EMPTY_CHAT_FIND
      return patch(state, sessionId, entry.open ? { focusTick: entry.focusTick + 1 } : { open: true, returnFocus })
    }),
  close: (sessionId) => set((state) => patch(state, sessionId, { open: false, returnFocus: null })),
  setQuery: (sessionId, query) => set((state) => patch(state, sessionId, { query })),
  setMatchCase: (sessionId, matchCase) => set((state) => patch(state, sessionId, { matchCase }))
}))

/** Opens (or re-focuses) the Session's find bar. Pass `returnFocus` when the opener unmounts. */
export function openChatFind(sessionId: string, returnFocus?: HTMLElement | null): void {
  useChatFindStore.getState().open(sessionId, returnFocus)
}

export function closeChatFind(sessionId: string): void {
  useChatFindStore.getState().close(sessionId)
}
