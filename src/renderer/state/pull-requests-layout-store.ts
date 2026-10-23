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
  /** `ResizablePanel`'s own `onResize` (`PanelSize.inPixels`): the SOLE write path, live state
   *  AND persistence (debounced ~300ms) together. Gate-fix (final root cause, caught live via
   *  tagged call-site instrumentation, replacing three prior rounds' worth of unreliable
   *  DOM/event heuristics -- M3's coordinate-proximity check, round 4's capture-phase before/
   *  after width snap, `onLayoutChanged`'s own `isUserInteraction` meta): all three tried to
   *  decide "was this interaction ours" from a SIGNAL (a click target, a flag) instead of the
   *  one thing that is always accurate -- the panel's own real rendered width, which `onResize`
   *  reports RELIABLY for every cause observed live (a drag, an arrow-key resize, the library's
   *  own internal double-click reset, and a passive reflow cascading down from an unrelated
   *  sibling Group's own resize). Persisting whatever `onResize` reports, unconditionally,
   *  means the persisted value can never go stale behind a sibling's resize again, and a
   *  genuine reset is captured even on the runs where `onLayoutChanged`'s own flag does not
   *  fire true for it (confirmed live: it fires true for SOME occurrences of the identical
   *  interaction and not others). A drag's or a passive cascade's many intermediate `onResize`
   *  ticks still coalesce to one write: every call clears and restarts the same 300ms timer, so
   *  only the FINAL settled width before the clock actually fires ever reaches disk -- including
   *  the brief, always-superseded-before-it-can-fire write of the panel's own `defaultSize`
   *  that happens on mount, one synchronous layout-effect tick before the mount-restore effect
   *  below's own imperative `resize()` call supersedes it with the real persisted width. */
  setWidth(widthPx: number): void
  /** App start: seeds the live value from the persisted `Settings` row -- deliberately bypasses
   *  `setWidth`'s own persist (nothing to write back, this IS what was just read). */
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
    // Gate-fix (round 3, Sec, caught across 3 rounds): `widthPx` off `PanelSize.inPixels` is
    // frequently a fraction (e.g. `319.984375`) -- the Rust side's own `as_i64` cast on the IPC
    // argument rejects a non-integer JSON number outright, so a fractional width never persisted
    // at all until the next integer-valued resize happened to land.
    window.refract.settings.setPullRequestsListWidth(Math.round(widthPx)).then(
      (result) => {
        if (!result.ok) console.error('settings.setPullRequestsListWidth failed', result.error)
      },
      (err: unknown) => console.error('settings.setPullRequestsListWidth threw', err)
    )
  }, 300)
}

export const usePullRequestsLayoutStore = create<PullRequestsLayoutState>((set) => ({
  widthPx: PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX,
  setWidth: (widthPx) => {
    set({ widthPx })
    persist(widthPx)
  },
  restoreFromSettings: (widthPx) => set({ widthPx })
}))
