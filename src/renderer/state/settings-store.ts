import { create } from 'zustand'
import { DEFAULT_SESSION_READOUT, DEFAULT_TRANSCRIPT_DISPLAY } from '../../shared/model'
import type { ApprovalMode, ReadoutKind, Settings, TranscriptDisplaySettings } from '../../shared/model'
import { notify } from './notify'
import { useChatScrollStore } from './scroll-store'

interface SettingsState {
  settings: Settings
  setSettings(settings: Settings): void
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<void>
  setWatermarkEnabled(enabled: boolean): Promise<void>
  setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible: boolean): Promise<void>
  setShowSampleData(enabled: boolean): Promise<void>
  setDetectImagePathsOnPaste(enabled: boolean): Promise<void>
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
  transcriptDisplay: DEFAULT_TRANSCRIPT_DISPLAY,
  showSampleData: false,
  detectImagePathsOnPaste: true
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
  setTranscriptDisplay: async (field, visible) => {
    const result = await window.refract.settings.setTranscriptDisplay(field, visible)
    if (result.ok) {
      set({ settings: result.value })
      // Issue #457 quality-gate fix (code review, Medium / a11y, Low): a remembered "detached"
      // scroll position was recorded against the pre-toggle row layout; restoring it once every
      // pane remounts (`App.tsx` replaces the whole chat area while Settings is open) can land on
      // unrelated content once hidden rows change the layout's height. Falls back to #485's own
      // default (the end) for every pane instead.
      useChatScrollStore.getState().clearAll()
    } else {
      notify(result.error)
    }
  },
  setShowSampleData: async (enabled) => {
    const result = await window.refract.settings.setShowSampleData(enabled)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setDetectImagePathsOnPaste: async (enabled) => {
    const result = await window.refract.settings.setDetectImagePathsOnPaste(enabled)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  }
}))
