// Decides by outcome, not by query/repo count: the filter wording fires only when no quick-create button
// exists in the DOM and focusing the search field (or, with its panel closed, the funnel) worked. A collapsed
// (inert) nav still has the button, so it falls through to the "Open the session list…" wording.
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { SESSION_FILTER_TOGGLE_SELECTOR, SESSION_SEARCH_INPUT_SELECTOR } from './sessionSearchSelector'

export function announceQuickCreateFallback(): void {
  const quickCreateButton = document.querySelector('[data-quick-create-session]')
  const searchInput = document.querySelector<HTMLInputElement>(SESSION_SEARCH_INPUT_SELECTOR)
  const filterToggle = document.querySelector<HTMLElement>(SESSION_FILTER_TOGGLE_SELECTOR)
  const target = searchInput ?? filterToggle
  if (!quickCreateButton && target) {
    target.focus()
    if (document.activeElement === target) {
      useChatAreaAnnouncer
        .getState()
        .announce(searchInput ? 'Clear the filter to choose a project for the new session' : 'Open the filter and clear it to choose a project for the new session')
      return
    }
  }
  useChatAreaAnnouncer.getState().announce('Open the session list to choose a project for the new session')
}
