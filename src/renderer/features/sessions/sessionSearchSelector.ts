/** DOM hook for the search field; `scripts/verify-tauri-session-list-helpers.mjs` mirrors this literal, keep in sync. */
export const SESSION_SEARCH_INPUT_ATTR = 'data-session-search-input'
export const SESSION_SEARCH_INPUT_SELECTOR = `[${SESSION_SEARCH_INPUT_ATTR}]`

/** DOM hook for the funnel that opens the search panel; the fallback focus target while the panel is closed. */
export const SESSION_FILTER_TOGGLE_ATTR = 'data-session-filter-toggle'
export const SESSION_FILTER_TOGGLE_SELECTOR = `[${SESSION_FILTER_TOGGLE_ATTR}]`

/** Focuses the session list's search field, or its funnel while the panel is closed; a no-op when neither is mounted or the nav is inert. */
export function focusSessionSearch(): void {
  const target =
    document.querySelector<HTMLElement>(SESSION_SEARCH_INPUT_SELECTOR) ?? document.querySelector<HTMLElement>(SESSION_FILTER_TOGGLE_SELECTOR)
  target?.focus()
}
