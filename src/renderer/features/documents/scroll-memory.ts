/** What a scroller remembers: where it was, and whether the saved position has been applied to it yet. */
export interface ScrollMemory {
  /** The position to apply once the content is ready and the scroller exists; null when not ready or already applied. */
  restore(ready: boolean, hasScroller: boolean): number | null
  /** Records a scroll event; positions before the restore are the browser starting at the top, so they are ignored. */
  track(scrollTop: number): void
  last(): number
}

export function createScrollMemory(initial: number | undefined): ScrollMemory {
  let last = initial ?? 0
  let restored = false
  return {
    restore(ready, hasScroller) {
      if (!ready || restored || !hasScroller) return null
      restored = true
      return last
    },
    track(scrollTop) {
      if (restored) last = scrollTop
    },
    last: () => last
  }
}
