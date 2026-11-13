import { create } from 'zustand'
import { DEFAULT_SESSION_LIST_COLLAPSE, DEFAULT_SESSION_READOUT, DEFAULT_TRANSCRIPT_DISPLAY } from '../../shared/model'
import type { Alarm, ApprovalMode, ReadoutKind, Settings, TranscriptDisplaySettings } from '../../shared/model'
import type { ActivityText } from '../../shared/activity'
import type { StatusStyle } from '../../shared/statusStyle'
import type { ChatRowDensity } from '../../shared/chatRowDensity'
import { DEFAULT_RIGHT_PANE } from '../../shared/rightPane'
import { PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX } from './pull-requests-layout-store'
import { notify } from './notify'
import { useChatScrollStore } from './scroll-store'

interface SettingsState {
  settings: Settings
  setSettings(settings: Settings): void
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<void>
  setWatermarkEnabled(enabled: boolean): Promise<void>
  setHolidayTouches(value: Settings['holidayTouches']): Promise<void>
  setActivityText(value: ActivityText): Promise<void>
  setStatusStyle(value: StatusStyle): Promise<void>
  setChatRowDensity(value: ChatRowDensity): Promise<void>
  setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible: boolean): Promise<void>
  setShowSampleData(enabled: boolean): Promise<void>
  setDetectImagePathsOnPaste(enabled: boolean): Promise<void>
  setShowContextUsageBar(enabled: boolean): Promise<void>
  setWordPredictionEnabled(enabled: boolean): Promise<void>
  /** Issue #1205 (FR-107): resolves `true` on success, so **Don't show again** only toasts a real change. */
  setShowAgentStoppedBar(enabled: boolean): Promise<boolean>
  setShowAiCredits(enabled: boolean): Promise<void>
  setAnimatedStatusText(enabled: boolean): Promise<boolean>
  setCodeLigatures(enabled: boolean): Promise<void>
  setShowScrollbarMap(enabled: boolean): Promise<void>
  setStackedPullRequests(enabled: boolean): Promise<void>
  setShowFinishedTurnTimes(enabled: boolean): Promise<void>
  setSessionNotificationSounds(enabled: boolean): Promise<void>
  setAlarmSounds(enabled: boolean): Promise<void>
  /** Resolves `true` on success so the form closes only after a real save. */
  upsertAlarm(alarm: Alarm): Promise<boolean>
  deleteAlarm(id: string): Promise<boolean>
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
  chatWidth: 'full',
  customTheme: null,
  holidayTouches: 'full',
  transcriptDisplay: DEFAULT_TRANSCRIPT_DISPLAY,
  showSampleData: false,
  detectImagePathsOnPaste: true,
  sessionListCollapse: DEFAULT_SESSION_LIST_COLLAPSE,
  rightPane: DEFAULT_RIGHT_PANE,
  pullRequestsListWidthPx: PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX, // #930: default and remembered-width floor; see `pull-requests-layout-store.ts`
  // Placeholder until the real row arrives (Rust default is `false`); `true` keeps ghost text from flickering off meanwhile.
  wordPredictionEnabled: true
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
  setHolidayTouches: async (value) => {
    const result = await window.refract.settings.setHolidayTouches(value)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setActivityText: async (value) => {
    const result = await window.refract.settings.setActivityText(value)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setStatusStyle: async (value) => {
    const result = await window.refract.settings.setStatusStyle(value)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setChatRowDensity: async (value) => {
    const result = await window.refract.settings.setChatRowDensity(value)
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
  },
  setShowContextUsageBar: async (enabled) => {
    const result = await window.refract.settings.setShowContextUsageBar(enabled)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setWordPredictionEnabled: async (enabled) => {
    const result = await window.refract.settings.setWordPredictionEnabled(enabled)
    if (result.ok) {
      set({ settings: result.value })
    } else {
      notify(result.error)
    }
  },
  setShowAgentStoppedBar: async (enabled) => {
    const result = await window.refract.settings.setShowAgentStoppedBar(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
    return result.ok
  },
  setShowAiCredits: async (enabled) => {
    const result = await window.refract.settings.setShowAiCredits(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  setAnimatedStatusText: async (enabled) => {
    const result = await window.refract.settings.setAnimatedStatusText(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
    return result.ok
  },
  setCodeLigatures: async (enabled) => {
    const result = await window.refract.settings.setCodeLigatures(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  setShowScrollbarMap: async (enabled) => {
    const result = await window.refract.settings.setShowScrollbarMap(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  setStackedPullRequests: async (enabled) => {
    const result = await window.refract.settings.setStackedPullRequests(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  setShowFinishedTurnTimes: async (enabled) => {
    const result = await window.refract.settings.setShowFinishedTurnTimes(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  setSessionNotificationSounds: async (enabled) => {
    const result = await window.refract.settings.setSessionNotificationSounds(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  setAlarmSounds: async (enabled) => {
    const result = await window.refract.settings.setAlarmSounds(enabled)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
  },
  upsertAlarm: async (alarm) => {
    const result = await window.refract.settings.upsertAlarm(alarm)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
    return result.ok
  },
  deleteAlarm: async (id) => {
    const result = await window.refract.settings.deleteAlarm(id)
    if (result.ok) set({ settings: result.value })
    else notify(result.error)
    return result.ok
  }
}))

// Issue #1246: globals.css reads this root attribute to turn Code font ligatures off.
function applyCodeLigatures(settings: Settings): void {
  if (settings.codeLigatures === false) document.documentElement.dataset.codeLigatures = 'off'
  else delete document.documentElement.dataset.codeLigatures
}

useSettingsStore.subscribe((state) => applyCodeLigatures(state.settings))
