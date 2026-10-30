import { create } from 'zustand'

// A store, not a hook, because closeChatPane.ts is a plain function. Clear-then-set-then-autoclear
// stops stale re-reads and swallowed identical announcements (#621).

interface ChatAreaAnnouncerState {
  text: string
  announce(text: string): void
}

export const useChatAreaAnnouncer = create<ChatAreaAnnouncerState>((set) => {
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
