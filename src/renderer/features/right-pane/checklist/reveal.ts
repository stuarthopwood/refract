import { useEffect, type RefObject } from 'react'
import { flashRowHighlight } from '@/features/chat-nav/highlightRow'
import { useChecklistStore, type RevealRequest } from '@/state/checklist-store'

/** What the panel is showing right now, as far as a reveal request is concerned. */
export interface RevealView {
  sessionId: string | null
  checklistId: string | null
  loaded: boolean
}

export type RevealVerdict = 'wait' | 'drop' | 'reveal'

/**
 * A request for another Session is left for when that Session is front; one for the front Session
 * that names a checklist the panel does not hold is dropped, except while the first load is pending.
 */
export function judgeReveal(request: RevealRequest, view: RevealView): RevealVerdict {
  if (request.sessionId !== view.sessionId) return 'wait'
  if (view.checklistId === null && !view.loaded) return 'wait'
  return request.checklistId === view.checklistId ? 'reveal' : 'drop'
}

/** The scrollTop that brings a row fully into view with the least movement. */
export function scrollTopToShow(scroller: { scrollTop: number; clientHeight: number }, row: { top: number; height: number }): number {
  if (row.top < scroller.scrollTop) return row.top
  const bottom = row.top + row.height
  if (bottom > scroller.scrollTop + scroller.clientHeight) return bottom - scroller.clientHeight
  return scroller.scrollTop
}

/** A rendered item: where it sits in the scroller's content, and what to do to it. */
export interface RevealRow {
  top: number
  height: number
  focusTick: () => void
  flash: () => void
}

export interface RevealScroller {
  scrollTop: number
  clientHeight: number
}

interface RunReveal {
  request: RevealRequest
  view: RevealView
  scroller: RevealScroller
  findRow: (itemId: string) => RevealRow | null
  clear: () => void
}

/** Scrolls to, focuses and flashes the requested item, then clears the one-shot request. */
export function runReveal({ request, view, scroller, findRow, clear }: RunReveal): void {
  const verdict = judgeReveal(request, view)
  if (verdict === 'wait') return
  const row = verdict === 'reveal' ? findRow(request.itemId) : null
  if (row !== null) {
    scroller.scrollTop = scrollTopToShow(scroller, row)
    row.focusTick()
    row.flash()
  }
  clear()
}

interface ScrollerElement extends RevealScroller {
  querySelectorAll: (selectors: string) => ArrayLike<HTMLElement>
  getBoundingClientRect: () => { top: number }
}

/** Finds the row by its item id and measures it against the scroller's content, not the viewport. */
export function findRevealRow(scroller: ScrollerElement, itemId: string): RevealRow | null {
  for (const element of Array.from(scroller.querySelectorAll('[data-checklist-item]'))) {
    if (element.dataset.checklistItem !== itemId) continue
    return {
      top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      height: element.getBoundingClientRect().height,
      // The row's own scroll is already done; a focus scroll would fight it.
      focusTick: () => element.querySelector<HTMLElement>("[data-slot='checkbox-item']")?.focus({ preventScroll: true }),
      flash: () => flashRowHighlight(element)
    }
  }
  return null
}

/** Consumes #2014's one-shot reveal request once the panel shows the right Session and checklist. */
export function useRevealRequest(view: RevealView, scrollerRef: RefObject<HTMLElement | null>): void {
  const request = useChecklistStore((state) => state.revealRequest)
  const { sessionId, checklistId, loaded } = view
  useEffect(() => {
    const scroller = scrollerRef.current
    if (request === null || scroller === null) return
    runReveal({
      request,
      view: { sessionId, checklistId, loaded },
      scroller,
      findRow: (itemId) => findRevealRow(scroller, itemId),
      clear: () => useChecklistStore.getState().clearReveal()
    })
  }, [request, sessionId, checklistId, loaded, scrollerRef])
}
