/** DOM hook for the search field; `scripts/verify-tauri-session-list-helpers.mjs` mirrors this literal, keep in sync. */
export const SESSION_SEARCH_INPUT_ATTR = 'data-session-search-input'
export const SESSION_SEARCH_INPUT_SELECTOR = `[${SESSION_SEARCH_INPUT_ATTR}]`

/** Focuses the session list's search field; a no-op when it is not mounted or the nav is inert. */
export function focusSessionSearchInput(): void {
  document.querySelector<HTMLInputElement>(SESSION_SEARCH_INPUT_SELECTOR)?.focus()
}
