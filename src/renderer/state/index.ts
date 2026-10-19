import { initStores } from './init-stores'
import { dismissSlashCommandRefusalToast, notify } from './notify'
import { useAdvisorStore } from './advisor-store'
import { useAlertDismissStore } from './alert-dismiss-store'
import { useAccountsStore } from './accounts'
import { useCommandsStore } from './commands-store'
import { useHealthStore } from './health-store'
import { useDraftStore } from './draft-store'
import { useMemoryStore } from './memory-store'
import { useModelRolesStore } from './model-roles-store'
import { usePendingRequestsStore } from './pending-requests-store'
import { EMPTY_QUEUE, useQueueStore } from './queue-store'
import { useRepositoriesStore } from './repositories-store'
import { DEFAULT_SETTINGS, useSettingsStore } from './settings-store'
import { useChatScrollStore } from './scroll-store'
import { useSessionsStore } from './sessions-store'
import { EMPTY_TRANSCRIPT, useTranscriptStore } from './transcript-store'
import { useViewStore } from './view-store'
import { EMPTY_READOUT, EMPTY_READOUT_ENTRY, useReadoutStore } from './readout-store'
import { useSubagentPanelStore } from './subagent-store'
import { SIDE_CHAT_LOADING_HINT, useSideChatStore } from './side-chat-store'
import { useFileExplorerStore } from './file-explorer-store'
import { RIGHT_PANE_DEFAULT_WIDTH_PX, RIGHT_PANE_MAX_WIDTH_PX, RIGHT_PANE_MIN_WIDTH_PX, useRightPaneStore } from './right-pane-store'
import { useSplitStore } from './split-store'
import { useSessionListStore } from './session-list-store'
import { usePullRequestsStore } from './pull-requests-store'
import { PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX, PULL_REQUESTS_LIST_MIN_WIDTH_PX, usePullRequestsLayoutStore } from './pull-requests-layout-store'
import { useThemeStore } from './theme-store'
import { useChatWidthStore } from './chat-width-store'
import { useStageToggleStore } from './stage-toggle-store'
import { useUpdateStore } from './update-store'

export { initStores }
export { dismissSlashCommandRefusalToast, notify }
export { useAccountsStore }
export { useAdvisorStore }
export { useAlertDismissStore }
export type { GithubStatus } from './accounts'
export { useCommandsStore }
export { useHealthStore }
export { useDraftStore }
export { useMemoryStore }
export { useModelRolesStore }
export { usePendingRequestsStore }
export { EMPTY_QUEUE, useQueueStore }
export { useRepositoriesStore }
export { DEFAULT_SETTINGS, useSettingsStore }
export { useChatScrollStore }
export { useSessionsStore }
export { EMPTY_TRANSCRIPT, useTranscriptStore }
export { useViewStore }
export type { MainView, SettingsSectionId } from './view-store'
export { EMPTY_READOUT, EMPTY_READOUT_ENTRY, useReadoutStore }
export { useSubagentPanelStore }
export { SIDE_CHAT_LOADING_HINT, useSideChatStore }
export { useFileExplorerStore }
export { RIGHT_PANE_DEFAULT_WIDTH_PX, RIGHT_PANE_MAX_WIDTH_PX, RIGHT_PANE_MIN_WIDTH_PX, useRightPaneStore }
export { useSplitStore }
export { useSessionListStore }
export { usePullRequestsStore }
export type { PullRequestsRepoState, PullRequestsActiveCount } from './pull-requests-store'
export { PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX, PULL_REQUESTS_LIST_MIN_WIDTH_PX, usePullRequestsLayoutStore }
export { useThemeStore, activeThemeId, useActiveThemeId, themeClassName, initThemeStore } from './theme-store'
export { useChatWidthStore, activeChatWidth, useActiveChatWidth } from './chat-width-store'
export { useUpdateStore }
export { useStageToggleStore }

/** The zustand store hooks exposed on `window.__refractStores` in dev builds. */
export interface RefractDevStores {
  accounts: typeof useAccountsStore
  alertDismiss: typeof useAlertDismissStore
  health: typeof useHealthStore
  advisor: typeof useAdvisorStore
  draft: typeof useDraftStore
  memory: typeof useMemoryStore
  modelRoles: typeof useModelRolesStore
  pendingRequests: typeof usePendingRequestsStore
  queue: typeof useQueueStore
  repositories: typeof useRepositoriesStore
  settings: typeof useSettingsStore
  scroll: typeof useChatScrollStore
  sessions: typeof useSessionsStore
  transcript: typeof useTranscriptStore
  view: typeof useViewStore
  readout: typeof useReadoutStore
  subagentPanel: typeof useSubagentPanelStore
  sideChat: typeof useSideChatStore
  fileExplorer: typeof useFileExplorerStore
  rightPane: typeof useRightPaneStore
  split: typeof useSplitStore
  pullRequests: typeof usePullRequestsStore
  pullRequestsLayout: typeof usePullRequestsLayoutStore
  theme: typeof useThemeStore
  chatWidth: typeof useChatWidthStore
  updates: typeof useUpdateStore
  stageToggle: typeof useStageToggleStore
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
    accounts: useAccountsStore,
    alertDismiss: useAlertDismissStore,
    advisor: useAdvisorStore,
    health: useHealthStore,
    draft: useDraftStore,
    memory: useMemoryStore,
    modelRoles: useModelRolesStore,
    pendingRequests: usePendingRequestsStore,
    queue: useQueueStore,
    repositories: useRepositoriesStore,
    settings: useSettingsStore,
    scroll: useChatScrollStore,
    sessions: useSessionsStore,
    transcript: useTranscriptStore,
    view: useViewStore,
    readout: useReadoutStore,
    subagentPanel: useSubagentPanelStore,
    sideChat: useSideChatStore,
    fileExplorer: useFileExplorerStore,
    rightPane: useRightPaneStore,
    split: useSplitStore,
    pullRequests: usePullRequestsStore,
    pullRequestsLayout: usePullRequestsLayoutStore,
    theme: useThemeStore,
    chatWidth: useChatWidthStore,
    updates: useUpdateStore,
    stageToggle: useStageToggleStore
  }
}
