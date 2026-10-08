import { create } from 'zustand'
import { DEFAULT_SESSION_READOUT, DEFAULT_TRANSCRIPT_DISPLAY } from '../../shared/model'
import type { ApprovalMode, ReadoutKind, Settings, TranscriptDisplaySettings } from '../../shared/model'
import { notify } from './notify'

interface SettingsState {
  settings: Settings
  setSettings(settings: Settings): void
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<void>
  setWatermarkEnabled(enabled: boolean): Promise<void>
  setTranscriptDisplay(display: TranscriptDisplaySettings): Promise<void>
}

// The app-wide Settings (contracts/ipc.md "Settings"): Approval mode and (spec 004) which
// readout chips show.
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  approvalMode: 'ask',
  sessionReadout: DEFAULT_SESSION_READOUT,
  split: null,
  theme: 'dark',
  watermarkEnabled: true,
  transcriptDisplay: DEFAULT_TRANSCRIPT_DISPLAY
}

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
  },
  setWatermarkEnabled: async (enabled) => {
    const result = await window.refract.settings.setWatermarkEnabled(enabled)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setTranscriptDisplay: async (display) => {
    const result = await window.refract.settings.setTranscriptDisplay(display)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  }
}))
