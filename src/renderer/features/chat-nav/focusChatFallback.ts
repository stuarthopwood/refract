import { getPane } from './search/findDom'

/** Focuses the transcript viewport, making it programmatically focusable first. */
export function focusTranscriptViewport(sessionId: string): void {
  const viewport = getPane(sessionId)?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
  if (!viewport) return
  if (!viewport.hasAttribute('tabindex')) viewport.setAttribute('tabindex', '-1')
  viewport.focus({ preventScroll: true })
}

/** Focus when the element that held it is gone: the composer, else the transcript viewport. */
export function focusChatFallback(sessionId: string): void {
  const composer = getPane(sessionId)?.querySelector<HTMLElement>('textarea')
  if (composer) composer.focus({ preventScroll: true })
  else focusTranscriptViewport(sessionId)
}
