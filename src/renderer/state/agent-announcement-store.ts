import { create } from 'zustand'

interface AgentAnnouncementState {
  message: string
  /** Bumped per announcement so a repeated message is still re-read by a screen reader. */
  serial: number
  announce(message: string): void
}

export const useAgentAnnouncementStore = create<AgentAnnouncementState>((set, get) => ({
  message: '',
  serial: 0,
  announce: (message) => set({ message, serial: get().serial + 1 })
}))
