import { create } from 'zustand'

interface AlertDismissState {
  memoryDismissed: boolean
  ompVersionDismissed: boolean
  // The hidden->shown "was shown" refs the announce effect uses to fire only once per
  // appearance (including a post-dismiss recurrence) -- same reasoning as the dismissed flags
  // above for why these moved out of component-local `useRef`s.
  memoryWasShown: boolean
  ompVersionWasShown: boolean
  // Issue #883: the downloaded-update notice is dismissed per version.
  updateDismissedVersion: string | null
  dismissUpdate(version: string): void
  dismissMemory(): void
  dismissOmpVersion(): void
  setMemoryWasShown(shown: boolean): void
  setOmpVersionWasShown(shown: boolean): void
}

export const useAlertDismissStore = create<AlertDismissState>((set) => ({
  memoryDismissed: false,
  ompVersionDismissed: false,
  memoryWasShown: false,
  ompVersionWasShown: false,
  updateDismissedVersion: null,
  dismissUpdate: (version) => set({ updateDismissedVersion: version }),
  dismissMemory: () => set({ memoryDismissed: true }),
  dismissOmpVersion: () => set({ ompVersionDismissed: true }),
  setMemoryWasShown: (shown) => set({ memoryWasShown: shown }),
  setOmpVersionWasShown: (shown) => set({ ompVersionWasShown: shown })
}))
