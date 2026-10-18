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
  /** `ResizablePanelGroup`'s own `onLayoutChanged` meta: persists (debounced ~300ms) the given
   *  width only when `isUserInteraction` is true (a pointer drag or an arrow-key resize), never
   *  for a programmatic layout set (initial mount, a window resize re-clamp). Gate-fix (round
   *  4, caught live): takes `widthPx` as an explicit argument, read by the CALLER from the
   *  panel's own real DOM measurement -- the previous version read `get().widthPx` from this
   *  store instead, which `setWidth` (wired to `onResize`) updates independently and can still
   *  be stale (the pre-interaction value) at the exact moment `onLayoutChanged` fires, since
   *  this library calls these two callbacks with no guaranteed relative order. A double-click
   *  reset's own `resetToDefault()` (always persists the hardcoded default) and THIS commit
   *  share one debounced timer (last call wins) -- when commit's own call read a stale width,
   *  it could fire after and overwrite the reset's own correct persist with a leftover,
   *  pre-reset value (confirmed live: a reset to 320 round-tripped the OLD dragged width, 433,
   *  through a relaunch instead). Reading the real DOM instead of store state is never stale:
   *  layout/style mutations are synchronous, unlike a Zustand state update's own timing.
   */
  commit(widthPx: number): void
  /** Gate-fix (H1, caught live 2026-10-18): `react-resizable-panels`' own double-click reset
   *  calls `panel.resize(defaultSize)` directly, never through `onLayoutChanged`'s
   *  `isUserInteraction` meta -- `commit(false)` (or no commit at all) never persists it, so the
   *  UI shows 320px but `settings.json` still holds whatever was dragged before, and a relaunch
   *  silently un-resets. Called from the handle's own `onDoubleClick` alongside the library's
   *  reset, so the reset is persisted the same way a drag is (`persist`, debounced). */
  resetToDefault(): void
  /** App start: seeds the live value from the persisted `Settings` row. */
  restoreFromSettings(widthPx: number): void
}

let persistTimer: number | undefined

// TEMPORARY diagnostic instrumentation (caught live round 4, two confirmed-wrong diagnoses in a
// row): exposes every persist() call -- its caller and the exact width -- on `window` so a live
// verify run can observe the real call sequence directly instead of guessing at it again.
// Remove once the actual root cause of the sidebar-dblclick/relaunch persist mismatch is found
// and fixed.
declare global {
  interface Window {
    __pullRequestsPersistLog?: Array<{ source: string; widthPx: number; at: number }>
    __pullRequestsClickLog?: Array<{ clientX: number; handleRect: { left: number; width: number } | null; distance: number | null; withinProximity: boolean; at: number }>
  }
}

function persist(widthPx: number, source: string): void {
  ;(window.__pullRequestsPersistLog ??= []).push({ source, widthPx, at: performance.now() })
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

export const usePullRequestsLayoutStore = create<PullRequestsLayoutState>((set, get) => ({
  widthPx: PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX,
  setWidth: (widthPx) => set({ widthPx }),
  commit: (widthPx) => {
    persist(widthPx, 'commit')
  },
  resetToDefault: () => {
    set({ widthPx: PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX })
    persist(PULL_REQUESTS_LIST_DEFAULT_WIDTH_PX, 'resetToDefault')
  },
  restoreFromSettings: (widthPx) => set({ widthPx })
}))
