import { create } from 'zustand'

// Spec 004 data-model.md "view-store.ts": the one view-switch store shared with spec 003
// ('pull-requests' view) and spec 008 ('settings' entry point, 'manage-sessions'); this spec
// implements only 'chat'/'settings' behaviour and leaves the other two as typed stubs that just
// set `view` (and `repositoryId` for openPullRequests), ready for those specs to build real
// behaviour on without re-touching this file's shape.

export type MainView = 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'
// Spec 007 adds 'appearance' later; not built here.
export type SettingsSectionId = 'session-readout'

interface ViewState {
  view: MainView
  repositoryId: string | null
  settingsSection: SettingsSectionId | null
  openChat(repositoryId?: string): void
  /** Typed stub for spec 003: sets view + repositoryId only. */
  openPullRequests(repositoryId: string): void
  openSettings(section?: SettingsSectionId): void
  /** Typed stub for spec 008: sets view only. */
  openManageSessions(): void
}

const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'session-readout'

export const useViewStore = create<ViewState>((set) => ({
  view: 'chat',
  repositoryId: null,
  settingsSection: null,
  openChat: (repositoryId) => set((state) => ({ view: 'chat', repositoryId: repositoryId ?? state.repositoryId })),
  openPullRequests: (repositoryId) => set({ view: 'pull-requests', repositoryId }),
  openSettings: (section) =>
    set({ view: 'settings', settingsSection: section === 'session-readout' ? section : DEFAULT_SETTINGS_SECTION }),
  openManageSessions: () => set({ view: 'manage-sessions' })
}))
