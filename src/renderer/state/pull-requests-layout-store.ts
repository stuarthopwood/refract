import { create } from 'zustand'

/** Min and default pixel widths of the Pull requests list column. */
export const PULL_REQUESTS_LIST_MIN_WIDTH_PX = 280
export const PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX = 320

interface PullRequestsLayoutState {
  /** Current rendered width in pixels; default 320px. */
  widthPx: number
  /** `ResizablePanel`'s `onResize`: the sole write path. Persists every reported width (debounced 300ms) so it never goes stale behind a sibling resize; flag-based heuristics proved unreliable. */
  setWidth(widthPx: number): void
  /** App start: seeds the live value from persisted settings without writing back. */
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
    // `PanelSize.inPixels` is often fractional; Rust's `as_i64` rejects non-integer JSON numbers.
    window.refract.settings.setPullRequestsListWidth(Math.round(widthPx)).then(
      (result) => {
        if (!result.ok) console.error('settings.setPullRequestsListWidth failed', result.error)
      },
      (err: unknown) => console.error('settings.setPullRequestsListWidth threw', err)
    )
  }, 300)
}

/** Persisted width of the Pull requests list column, shared by every Project. */
export const usePullRequestsLayoutStore = create<PullRequestsLayoutState>((set) => ({
  widthPx: PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX,
  setWidth: (widthPx) => {
    set({ widthPx })
    persist(widthPx)
  },
  restoreFromSettings: (widthPx) => set({ widthPx })
}))
