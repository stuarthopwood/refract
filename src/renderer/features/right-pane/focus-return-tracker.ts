import { useDocumentTabsStore } from '@/state/document-tabs-store'

export type FocusLocation = 'body' | 'tab-strip' | 'other'

type TabsBySession = Record<string, { tabs: readonly { id: string }[] } | undefined>

/** Removes every remembered origin whose tab is gone and returns those whose Session still exists; a deleted Session has no row to return to. */
export function takeClosedOrigins(map: Map<string, string>, bySession: TabsBySession): { sessionId: string; value: string }[] {
  const closed: { sessionId: string; value: string }[] = []
  for (const [key, value] of [...map]) {
    const cut = key.indexOf('\n')
    const sessionId = key.slice(0, cut)
    const documents = bySession[sessionId]
    if (documents?.tabs.some((tab) => tab.id === key.slice(cut + 1))) continue
    map.delete(key)
    if (documents) closed.push({ sessionId, value })
  }
  return closed
}

/** Focus goes back to the row only when its panel is showing and focus was lost to the closed tab (body) or sits on the strip; a Ctrl+click open keeps focus on the list, so a later eviction never steals it. */
export function shouldReturnFocusToRow(panelShowing: boolean, focus: FocusLocation): boolean {
  return panelShowing && focus !== 'other'
}

/** Where focus sits relative to the tab strip; `active` is `document.activeElement`. */
export function focusLocation(active: Pick<Element, 'closest'> | null, body: unknown): FocusLocation {
  if (!active || active === body) return 'body'
  // A close that leaves one item focuses the single-item header's close button, which has no tablist.
  return active.closest('[role="tablist"], [data-panel-close]') ? 'tab-strip' : 'other'
}

/** Runs `step` each frame until it reports it is settled; `onGiveUp` runs once if `framesLeft` runs out first. */
export function pollUntilSettled(step: () => boolean, nextFrame: (run: () => void) => void, framesLeft: number, onGiveUp?: () => void): void {
  if (step()) return
  if (framesLeft <= 0) return onGiveUp?.()
  nextFrame(() => pollUntilSettled(step, nextFrame, framesLeft - 1, onGiveUp))
}

const POLL_FRAMES = 90

export interface OriginTrackerOptions {
  /** Whether the panel that owns the rows is the front tab; rows only exist while it shows. */
  isShowing(): boolean
  /** Tries to focus the row for a remembered value; true once focus landed, false to keep polling. */
  focusTarget(sessionId: string, value: string): boolean
  /** Runs once if the row never mounted within the poll window and the panel still should take focus. */
  focusFallback?(sessionId: string, value: string): void
}

export interface OriginTracker {
  /** Origins by `sessionId\ntabId`; exposed so a retarget can carry one over to the renamed tab. */
  readonly origins: Map<string, string>
  remember(sessionId: string, tabId: string, value: string): void
  /** Drops origins, the store subscription and any running poll; for tests. */
  reset(): void
}

/**
 * Tracks which panel row opened a document tab so closing the tab sends focus back (#2075 FR-005, FR-006). The panel is
 * unmounted while a document tab is active, so this lives outside it. One poll runs at a time: a newer close replaces it.
 */
export function createOriginTracker(options: OriginTrackerOptions): OriginTracker {
  const origins = new Map<string, string>()
  let unsubscribe: (() => void) | null = null
  let pollToken = 0

  function returnFocus(sessionId: string, value: string): void {
    const token = ++pollToken
    const stale = () => token !== pollToken
    // Two frames: the strip's own focus move after a close runs in the next one. A panel can mount its rows later (~250 ms live), so poll for the row.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (stale()) return
        pollUntilSettled(
          () => stale() || !shouldReturnFocusToRow(options.isShowing(), focusLocation(document.activeElement, document.body)) || options.focusTarget(sessionId, value),
          requestAnimationFrame,
          POLL_FRAMES,
          () => {
            if (shouldReturnFocusToRow(options.isShowing(), focusLocation(document.activeElement, document.body))) options.focusFallback?.(sessionId, value)
          }
        )
      })
    )
  }

  function subscribe(): void {
    // Installed on the first remembered origin and kept for the renderer's lifetime: it is one cheap listener that returns early with no origins.
    unsubscribe = useDocumentTabsStore.subscribe((state, previous) => {
      if (origins.size === 0 || state.bySession === previous.bySession) return
      const [first] = takeClosedOrigins(origins, state.bySession)
      if (first) returnFocus(first.sessionId, first.value)
    })
  }

  return {
    origins,
    remember(sessionId, tabId, value) {
      origins.set(`${sessionId}\n${tabId}`, value)
      if (!unsubscribe) subscribe()
    },
    reset() {
      unsubscribe?.()
      unsubscribe = null
      origins.clear()
      pollToken++
    }
  }
}
