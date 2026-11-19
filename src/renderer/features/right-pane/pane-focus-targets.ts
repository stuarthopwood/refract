/** Where focus goes when the strip is gone: the launcher's first row, else the rail's right-pane toggle (which is always mounted). */
export const EMPTY_PANE_FOCUS_SELECTORS = ['[data-panel-launcher] button', '[data-rail-toggle]'] as const

/** The first selector that finds an element. */
export function firstMatch<T>(selectors: readonly string[], query: (selector: string) => T | null): T | null {
  for (const selector of selectors) {
    const found = query(selector)
    if (found) return found
  }
  return null
}

/** Focus is stranded when nothing holds it or the holder left the document. */
export function isFocusStranded(active: { isConnected: boolean } | null, body: unknown): boolean {
  return !active || active === body || !active.isConnected
}

/** A Session switch restores focus only when it was on the strip before the switch and the switch took its element away. */
export function shouldRestoreFocusAfterSwitch(sessionChanged: boolean, focusWasInStrip: boolean, stranded: boolean): boolean {
  return sessionChanged && focusWasInStrip && stranded
}
