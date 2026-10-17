// Issue #930 (resizable Pull requests list column): a single persisted width, one for every
// Project (not per-repository) -- mirrors `split-store.ts`'s own debounced-persist pattern for
// `dividerPercent`, but for a pixel width (`ResizablePanel`'s own `minSize`/`maxSize`/`defaultSize`
// accept raw pixel numbers directly, per `react-resizable-panels` 4.14.1's "numbers are pixels"
// interpretation rule -- no percent conversion needed, unlike an older library version might).
import { create } from 'zustand'

export const PULL_REQUESTS_LIST_MIN_WIDTH_PX = 280
export const PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX = 320

interface PullRequestsLayoutState {
  /** Current rendered width in pixels; default 320px. */
  widthPx: number
  /** `ResizablePanel`'s own `onResize` (`PanelSize.inPixels`): always updates the live value,
   *  never persists by itself -- `commit` below decides that, the same split between "live" and
   *  "persisted" `split-store.ts`'s `setDividerPercent`/`onLayoutChange` pair uses. */
  setWidth(widthPx: number): void
  /** `ResizablePanelGroup`'s own `onLayoutChanged` meta: persists (debounced ~300ms) the
   *  CURRENT `widthPx` only when `isUserInteraction` is true (a pointer drag or an arrow-key
   *  resize), never for a programmatic layout set (initial mount, a window resize re-clamp). */
  commit(isUserInteraction: boolean): void
  /** App start: seeds the live value from the persisted `Settings` row. */
  restoreFromSettings(widthPx: number): void
}

let persistTimer: number | undefined

function persist(widthPx: number): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    window.refract.settings.setPullRequestsListWidth(widthPx).then(
      (result) => {
        if (!result.ok) console.error('settings.setPullRequestsListWidth failed', result.error)
      },
      (err: unknown) => console.error('settings.setPullRequestsListWidth threw', err)
    )
  }, 300)
}

export const usePullRequestsLayoutStore = create<PullRequestsLayoutState>((set, get) => ({
  widthPx: PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX,
  setWidth: (widthPx) => set({ widthPx }),
  commit: (isUserInteraction) => {
    if (isUserInteraction) persist(get().widthPx)
  },
  restoreFromSettings: (widthPx) => set({ widthPx })
}))
