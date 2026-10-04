import { initStores } from './init-stores'
import { notify } from './notify'
import { useCommandsStore } from './commands-store'
import { useDraftStore } from './draft-store'
import { useMemoryStore } from './memory-store'
import { usePendingRequestsStore } from './pending-requests-store'
import { EMPTY_QUEUE, useQueueStore } from './queue-store'
import { useRepositoriesStore } from './repositories-store'
import { DEFAULT_SETTINGS, useSettingsStore } from './settings-store'
import { useSessionsStore } from './sessions-store'
import { EMPTY_TRANSCRIPT, useTranscriptStore } from './transcript-store'
import { useViewStore } from './view-store'
import { EMPTY_READOUT, EMPTY_READOUT_ENTRY, useReadoutStore } from './readout-store'
import { useSubagentPanelStore } from './subagent-store'
import { useSplitStore } from './split-store'
import { useThemeStore } from './theme-store'

export { initStores }
export { notify }
export { useCommandsStore }
export { useDraftStore }
export { useMemoryStore }
export { usePendingRequestsStore }
export { EMPTY_QUEUE, useQueueStore }
export { useRepositoriesStore }
export { DEFAULT_SETTINGS, useSettingsStore }
export { useSessionsStore }
export { EMPTY_TRANSCRIPT, useTranscriptStore }
export { useViewStore }
export type { MainView, SettingsSectionId } from './view-store'
export { EMPTY_READOUT, EMPTY_READOUT_ENTRY, useReadoutStore }
export { useSubagentPanelStore }
export { useSplitStore }
export { useThemeStore, activeThemeId, useActiveThemeId, themeClassName, initThemeStore } from './theme-store'

/** The zustand store hooks exposed on `window.__refractStores` in dev builds. */
export interface RefractDevStores {
  commands: typeof useCommandsStore
  draft: typeof useDraftStore
  memory: typeof useMemoryStore
  pendingRequests: typeof usePendingRequestsStore
  queue: typeof useQueueStore
  repositories: typeof useRepositoriesStore
  settings: typeof useSettingsStore
  sessions: typeof useSessionsStore
  transcript: typeof useTranscriptStore
  view: typeof useViewStore
  readout: typeof useReadoutStore
  subagentPanel: typeof useSubagentPanelStore
  split: typeof useSplitStore
  theme: typeof useThemeStore
}

declare global {
  interface Window {
    __refractStores?: RefractDevStores
  }
}

// DEV-only: lets verification scripts inject store state through CDP (`window.__refractStores`)
// without a working main process, since main's handlers land in parallel with the renderer.
// Never referenced by production code.
if (import.meta.env.DEV) {
  window.__refractStores = {
    commands: useCommandsStore,
    draft: useDraftStore,
    memory: useMemoryStore,
    pendingRequests: usePendingRequestsStore,
    queue: useQueueStore,
    repositories: useRepositoriesStore,
    settings: useSettingsStore,
    sessions: useSessionsStore,
    transcript: useTranscriptStore,
    view: useViewStore,
    readout: useReadoutStore,
    subagentPanel: useSubagentPanelStore,
    split: useSplitStore,
    theme: useThemeStore
  }
}
