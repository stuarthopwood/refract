import { create } from 'zustand'
import { DEFAULT_FILTERS } from '@/features/profile/manageSessionsHelpers'
import type { SessionFilters } from '@/features/profile/manageSessionsHelpers'

// Spec 004 data-model.md "view-store.ts": the one view-switch store shared with spec 003
// ('pull-requests' view) and spec 008 ('settings' entry point, 'manage-sessions'); 'pull-requests'
// remains a typed stub (sets `view`/`repositoryId` only) ready for that spec to build real
// behaviour on without re-touching this file's shape -- 'settings' and 'manage-sessions' are
// both real screens now (SettingsScreen.tsx, ManageSessionsScreen.tsx).

export type MainView = 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'
export type SettingsSectionId = 'session-readout' | 'appearance'

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
  /** Typed stub for spec 003: sets view + repositoryId only. */
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
