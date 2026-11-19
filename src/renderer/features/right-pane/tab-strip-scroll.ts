export interface StripView {
  scrollLeft: number
  viewWidth: number
}

/** A tab's span in the scroller's content coordinates (its left edge already includes the current scroll). */
export interface TabSpan {
  start: number
  width: number
}

/** The scroll offset that shows `tab` with the least movement; a tab wider than the view lines up at its start. Moves the strip's own scroller only, never an ancestor like `scrollIntoView` can. */
export function scrollLeftToReveal({ scrollLeft, viewWidth }: StripView, { start, width }: TabSpan): number {
  const end = start + width
  if (width >= viewWidth || start < scrollLeft) return start
  if (end > scrollLeft + viewWidth) return end - viewWidth
  return scrollLeft
}
