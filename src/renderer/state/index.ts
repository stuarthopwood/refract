import { initStores } from './init-stores'
import { notify } from './notify'
import { useCommandsStore } from './commands-store'
import { useMemoryStore } from './memory-store'
import { usePendingRequestsStore } from './pending-requests-store'
import { useQueueStore } from './queue-store'
import { useRepositoriesStore } from './repositories-store'
import { DEFAULT_SETTINGS, useSettingsStore } from './settings-store'
import { useSessionsStore } from './sessions-store'
import { useTranscriptStore } from './transcript-store'

export { initStores }
export { notify }
export { useCommandsStore }
export { useMemoryStore }
export { usePendingRequestsStore }
export { useQueueStore }
export { useRepositoriesStore }
export { DEFAULT_SETTINGS, useSettingsStore }
export { useSessionsStore }
export { useTranscriptStore }

/** The zustand store hooks exposed on `window.__pinionStores` in dev builds. */
export interface PinionDevStores {
  commands: typeof useCommandsStore
  memory: typeof useMemoryStore
  pendingRequests: typeof usePendingRequestsStore
  queue: typeof useQueueStore
  repositories: typeof useRepositoriesStore
  settings: typeof useSettingsStore
  sessions: typeof useSessionsStore
  transcript: typeof useTranscriptStore
}

declare global {
  interface Window {
    __pinionStores?: PinionDevStores
  }
}

// DEV-only: lets verification scripts inject store state through CDP (`window.__pinionStores`)
// without a working main process, since main's handlers land in parallel with the renderer.
// Never referenced by production code.
if (import.meta.env.DEV) {
  window.__pinionStores = {
    commands: useCommandsStore,
    memory: useMemoryStore,
    pendingRequests: usePendingRequestsStore,
    queue: useQueueStore,
    repositories: useRepositoriesStore,
    settings: useSettingsStore,
    sessions: useSessionsStore,
    transcript: useTranscriptStore
  }
}
