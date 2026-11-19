import { RIGHT_PANE_CONTENT_SELECTOR } from '@/lib/right-pane-selectors'
import { tabDomIds } from './tab-items'

/** Focuses a document tab's strip button; false when the strip shows no button for it (a lone tab has only a title row) or focus did not land. */
export function focusDocumentTab(sessionId: string, tabId: string): boolean {
  const button = document.getElementById(tabDomIds({ kind: 'document', sessionId, id: tabId }).tabId)
  button?.focus()
  return button !== null && document.activeElement === button
}

/** The shell only moves focus for a new tab, so an already open one is focused here; the lone-tab fallback is the content. */
export function focusExistingDocumentTab(sessionId: string, tabId: string): void {
  requestAnimationFrame(() => {
    if (!focusDocumentTab(sessionId, tabId)) document.querySelector<HTMLElement>(RIGHT_PANE_CONTENT_SELECTOR)?.focus()
  })
}
