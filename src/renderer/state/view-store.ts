import { create } from 'zustand'

// Spec 004 data-model.md "view-store.ts": the one view-switch store shared with spec 003
// ('pull-requests' view) and spec 008 ('settings' entry point, 'manage-sessions'); all three are
// real screens now (PullRequestsView.tsx, SettingsScreen.tsx, ManageSessionsScreen.tsx) -- this
// store only holds the switch itself plus the small per-view state (`repositoryId`,
// `settingsSection`, `manageSessionsFilters`) each screen needs to survive being unmounted and
// remounted when `view` changes (App.tsx swaps the whole main area on it).

export type MainView = 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'
export type SettingsSectionId = 'session-readout' | 'appearance'

export type ArchiveFilter = 'all' | 'active' | 'archived'
export type SortKey = 'recent' | 'name' | 'repo' | 'status'

/** Spec 008 FR-025 "Manage sessions" screen filters (search/repository/archive/sort). Defined
 *  here, not in `features/profile/manageSessionsHelpers.ts`, so the state layer never imports
 *  from a feature module -- the helpers, the screen, and the toolbar import this type (and
 *  `DEFAULT_FILTERS`) from here instead. */
export interface SessionFilters {
  search: string
  repositoryId: string // 'all' or a real Repository id
  archiveFilter: ArchiveFilter
  sort: SortKey
}

export const DEFAULT_FILTERS: SessionFilters = {
  search: '',
  repositoryId: 'all',
  archiveFilter: 'all',
  sort: 'recent'
}

interface ViewState {
  view: MainView
  repositoryId: string | null
  settingsSection: SettingsSectionId | null
  /** Post-build review fix (Phase7PostBuild, Low): lives here, not as local `useState` on
   *  ManageSessionsScreen.tsx, so the search/repository/archive/sort filters survive opening a
   *  Session (which unmounts that screen entirely, App.tsx swapping the whole main area on
   *  `view`) and coming back via the profile menu's "Manage sessions" item again. */
  manageSessionsFilters: SessionFilters
  openChat(repositoryId?: string): void
  openPullRequests(repositoryId: string): void
  openSettings(section?: SettingsSectionId): void
  openManageSessions(): void
  setManageSessionsFilters(filters: SessionFilters): void
}

const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'session-readout'

export const useViewStore = create<ViewState>((set) => ({
  view: 'chat',
  repositoryId: null,
  settingsSection: null,
  manageSessionsFilters: DEFAULT_FILTERS,
  openChat: (repositoryId) => set((state) => ({ view: 'chat', repositoryId: repositoryId ?? state.repositoryId })),
  openPullRequests: (repositoryId) => set({ view: 'pull-requests', repositoryId }),
  openSettings: (section) =>
    set({
      view: 'settings',
      settingsSection: section === 'session-readout' || section === 'appearance' ? section : DEFAULT_SETTINGS_SECTION
    }),
  openManageSessions: () => set({ view: 'manage-sessions' }),
  setManageSessionsFilters: (filters) => set({ manageSessionsFilters: filters })
}))
