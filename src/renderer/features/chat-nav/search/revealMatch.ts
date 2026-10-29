import { NAV_HIGHLIGHT_ATTRIBUTE } from '../highlightRow'
import { getPane, mountedRows, renderedRanges } from './findDom'

const POLL_MS = 80
const GIVE_UP_MS = 3000
const BAR_GAP_PX = 24

export interface RevealTarget {
  sessionId: string
  messageId: string
  ordinal: number
  query: string
  matchCase: boolean
  /** True when the row is already on screen, so there is no jump to wait for. */
  immediate: boolean
}

/** After a jump lands (the row carries the landing flash), nudges the scroller so the current
 * match is visible and not hidden under the find bar. Returns a cancel function. */
export function revealMatchWhenLanded(target: RevealTarget): () => void {
  const startedAt = Date.now()
  let timer: number | undefined
  function attempt() {
    const pane = getPane(target.sessionId)
    const row = pane ? mountedRows(pane).get(target.messageId) : undefined
    const landed = row?.hasAttribute(NAV_HIGHLIGHT_ATTRIBUTE) ?? false
    if (pane && row && (landed || target.immediate)) {
      scrollMatchIntoView(pane, renderedRanges(row, target.query, target.matchCase)[target.ordinal])
      return
    }
    if (Date.now() - startedAt < GIVE_UP_MS) timer = window.setTimeout(attempt, POLL_MS)
  }
  attempt()
  return () => window.clearTimeout(timer)
}

function scrollMatchIntoView(pane: HTMLElement, range: Range | undefined): void {
  const viewport = pane.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
  if (!range || !viewport) return
  const rect = range.getBoundingClientRect()
  const view = viewport.getBoundingClientRect()
  const barBottom = pane.querySelector('[data-chat-find]')?.getBoundingClientRect().bottom ?? view.top
  const top = Math.max(view.top, barBottom) + BAR_GAP_PX
  if (rect.top < top || rect.bottom > view.bottom - BAR_GAP_PX) viewport.scrollTop += rect.top - top
}
