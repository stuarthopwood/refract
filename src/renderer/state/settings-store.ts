import { create } from 'zustand'
import { DEFAULT_SESSION_READOUT } from '../../shared/model'
import type { ApprovalMode, ReadoutKind, Settings } from '../../shared/model'
import { notify } from './notify'

interface SettingsState {
  settings: Settings
  setSettings(settings: Settings): void
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<void>
}

// The app-wide Settings (contracts/ipc.md "Settings"): Approval mode and (spec 004) which
// readout chips show.
export const DEFAULT_SETTINGS: Settings = { version: 1, approvalMode: 'ask', sessionReadout: DEFAULT_SESSION_READOUT }

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  setSettings: (settings) => set({ settings }),
  setApprovalMode: async (mode) => {
    const result = await window.refract.settings.setApprovalMode(mode)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setReadoutVisibility: async (kind, visible) => {
    const result = await window.refract.settings.setReadoutVisibility(kind, visible)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  }
}))
