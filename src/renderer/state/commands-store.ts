import { create } from 'zustand'
import type { SlashCommand } from '../../shared/ipc'

interface CommandsState {
  bySession: Record<string, SlashCommand[]>
  setForSession(sessionId: string, commands: SlashCommand[]): void
}

// The latest slash-command list per Session (contracts/ipc.md `commands:update`).
export const useCommandsStore = create<CommandsState>((set, get) => ({
  bySession: {},
  setForSession: (sessionId, commands) => set({ bySession: { ...get().bySession, [sessionId]: commands } })
}))
