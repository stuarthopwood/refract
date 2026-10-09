import { create } from 'zustand'

// Issue #621 (close chat pane): the chat area's own app-level "Closed {name} chat pane" polite
// announcement needs to be reachable from `closeChatPane.ts`, a plain function shared by
// ChatHeader's close button AND App.tsx's Ctrl+W listener -- neither of which is a hook/component,
// so `use-cleared-announcement.ts`'s own `useState`-based hook (the pattern this mirrors) cannot
// be used directly. A tiny Zustand store plays the same role: `App.tsx` reads `text` to render the
// one `aria-live="polite"` region (mounted outside ChatPane, per the decision), and `announce()`
// keeps the same "clear to '' first, then set on the next tick, then auto-clear" shape so a
// screen reader that tabs back into the region later never re-reads a stale announcement, and two
// textually-identical announcements in a row are never silently swallowed.

interface ChatAreaAnnouncerState {
  text: string
  announce(text: string): void
}

export const useChatAreaAnnouncer = create<ChatAreaAnnouncerState>((set) => {
  // Browser `setTimeout` (renderer/DOM code, not Node) returns a numeric handle (quality-gate
  // remediation, code-reviewer LOW, PR #634: matches `split-store.ts`'s own `persistTimer`
  // pattern, inline rather than a one-consumer exported type).
  let clearTimer: number | undefined
  let pendingTimer: number | undefined
  return {
    text: '',
    announce: (next) => {
      clearTimeout(clearTimer)
      clearTimeout(pendingTimer)
      set({ text: '' })
      pendingTimer = setTimeout(() => {
        set({ text: next })
        clearTimer = setTimeout(() => set({ text: '' }), 6000)
      }, 0)
    }
  }
})
