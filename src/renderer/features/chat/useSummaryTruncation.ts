import * as React from 'react'

/** True when a single-line `truncate` box clips its text. */
export function isTextClipped(box: { scrollWidth: number; clientWidth: number }): boolean {
  return box.scrollWidth > box.clientWidth
}

/** Whether a row with a body gets an expand control (#1875): a body that adds content, a clipped summary, or a row already open. */
export function isRowExpandable({ bodyAddsContent, summaryClipped, open }: { bodyAddsContent: boolean; summaryClipped: boolean; open: boolean }): boolean {
  return bodyAddsContent || summaryClipped || open
}

/**
 * Once a summary has been seen clipped the row stays expandable: dropping the control when a later measure
 * reads "fits" would swap the row's element type and lose keyboard focus.
 */
export function latchClipped(latched: boolean, measured: boolean): boolean {
  return latched || measured
}

/**
 * Tracks whether the summary element has been truncated. Returns a callback ref for the summary span and the
 * latched flag (see {@link latchClipped}). Re-measures after every render (streaming text changes scrollWidth
 * without resizing the box) and on resize. `enabled` false skips all observation.
 */
export function useSummaryTruncation(enabled: boolean): { summaryRef: (el: HTMLSpanElement | null) => void; clipped: boolean } {
  const [element, setElement] = React.useState<HTMLSpanElement | null>(null)
  const [clipped, setClipped] = React.useState(false)

  React.useLayoutEffect(() => {
    if (!enabled || !element) return
    setClipped((prev) => latchClipped(prev, isTextClipped(element)))
  })

  React.useEffect(() => {
    if (!enabled || !element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setClipped((prev) => latchClipped(prev, isTextClipped(element)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, element])

  return { summaryRef: setElement, clipped }
}
