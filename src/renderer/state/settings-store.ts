import { create } from 'zustand'
import type { ApprovalMode, Settings } from '../../shared/model'
import { notify } from './notify'

interface SettingsState {
  settings: Settings
  setSettings(settings: Settings): void
  setApprovalMode(mode: ApprovalMode): Promise<void>
}

// The app-wide Settings (contracts/ipc.md "Settings"): currently just Approval mode.
export const DEFAULT_SETTINGS: Settings = { version: 1, approvalMode: 'ask' }

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
  }
}))
