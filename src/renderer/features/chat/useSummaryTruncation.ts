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
 * Tracks whether the summary element is visually truncated. Returns a callback ref for the summary span and the
 * current flag. Re-measures after every render (streaming text changes scrollWidth without resizing the box) and
 * on resize (the pane narrowing or widening). `enabled` false skips all observation.
 */
export function useSummaryTruncation(enabled: boolean): { summaryRef: (el: HTMLSpanElement | null) => void; clipped: boolean } {
  const [element, setElement] = React.useState<HTMLSpanElement | null>(null)
  const [clipped, setClipped] = React.useState(false)

  React.useLayoutEffect(() => {
    if (!enabled || !element) return
    const next = isTextClipped(element)
    setClipped((prev) => (prev === next ? prev : next))
  })

  React.useEffect(() => {
    if (!enabled || !element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const next = isTextClipped(element)
      setClipped((prev) => (prev === next ? prev : next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, element])

  return { summaryRef: setElement, clipped: enabled && clipped }
}
