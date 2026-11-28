import { useCallback, useEffect, useRef } from 'react'
import type { FocusEvent, RefObject } from 'react'
import { RIGHT_PANE_CONTENT_SELECTOR } from '@/lib/right-pane-selectors'
import { focusLostToPrune, type PanelRow } from './subagentPanelRows'

export interface Focusable {
  focus(): void
}

export interface FocusRoot {
  querySelector(selector: string): Focusable | null
}

type RowElements = ReadonlyMap<string, Pick<Node, 'contains'>>

/** Remembers which tree row focus was last in, so a prune that removes exactly that row hands focus on instead of dropping it to the page. */
export class PanelFocusTracker {
  private focusedKey: string | null = null

  track(rowElements: RowElements, target: Node): void {
    for (const [key, element] of rowElements) {
      if (element.contains(target)) {
        this.focusedKey = key
        return
      }
    }
  }

  // A removed row's blur arrives on a detached node; only an attached one means focus really left the row.
  release(target: { isConnected: boolean }): void {
    if (target.isConnected) this.focusedKey = null
  }

  /** Focuses the tree heading, or `fallback` when no heading is left (every row pruned), if focus fell to the page because its row went. */
  recover(rows: readonly PanelRow[], env: { root: FocusRoot | null; fallback: () => Focusable | null; active: unknown; body: unknown }): void {
    if (!focusLostToPrune(this.focusedKey, rows, env.active === null || env.active === env.body)) return
    this.focusedKey = null
    const heading = env.root?.querySelector('[data-panel-heading]') ?? null
    ;(heading ?? env.fallback())?.focus()
  }
}

export function usePanelFocusRecovery(
  rows: readonly PanelRow[],
  rowRefs: RefObject<RowElements>,
  treeHostRef: RefObject<HTMLElement | null>
): { trackFocus: (event: FocusEvent<HTMLElement>) => void; releaseFocus: (event: FocusEvent<HTMLElement>) => void } {
  const trackerRef = useRef<PanelFocusTracker | null>(null)
  trackerRef.current ??= new PanelFocusTracker()
  const tracker = trackerRef.current

  useEffect(() => {
    const host = treeHostRef.current
    tracker.recover(rows, {
      root: host ? { querySelector: (selector) => host.querySelector<HTMLElement>(selector) } : null,
      fallback: () => document.querySelector<HTMLElement>(RIGHT_PANE_CONTENT_SELECTOR),
      active: document.activeElement,
      body: document.body
    })
  }, [rows, tracker, treeHostRef])

  const trackFocus = useCallback((event: FocusEvent<HTMLElement>) => tracker.track(rowRefs.current, event.target), [tracker, rowRefs])
  const releaseFocus = useCallback((event: FocusEvent<HTMLElement>) => tracker.release(event.target), [tracker])
  return { trackFocus, releaseFocus }
}
