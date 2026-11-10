import { create } from 'zustand'

interface AgentAnnouncementState {
  message: string
  /** Bumped per announcement so a repeated message is still re-read by a screen reader. */
  serial: number
  announce(message: string): void
}

const CLEAR_AFTER_MS = 5000
let clearTimer: number | undefined

export const useAgentAnnouncementStore = create<AgentAnnouncementState>((set, get) => ({
  message: '',
  serial: 0,
  announce: (message) => {
    set({ message, serial: get().serial + 1 })
    // Cleared after it has been read, so browse mode does not re-read stale text.
    window.clearTimeout(clearTimer)
    clearTimer = window.setTimeout(() => set({ message: '' }), CLEAR_AFTER_MS)
  }
}))
