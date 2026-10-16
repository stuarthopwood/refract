// Issue #559 gate round 3 (finding 11): the ONE place the search field's own stable DOM hook
// lives, so every consumer -- SessionList.tsx (which sets the attribute on the rendered
// `<input>` via `SearchField`'s own `inputProps`), App.tsx's Ctrl+N fallback
// (`quickCreateFallback.ts`), and the shared focus-redirect hook
// (`useFocusSearchOnStrandedUnmount.ts`) -- can never drift onto two different selector
// strings. The live-check script (`scripts/verify-tauri-559.mjs`, plain Node, cannot import
// this TS module) mirrors this exact literal in its own `SEARCH_INPUT_FINDER` constant
// (`scripts/verify-tauri-session-list-helpers.mjs`); keep the two in sync by hand if this ever
// changes.
export const SESSION_SEARCH_INPUT_ATTR = 'data-session-search-input'
export const SESSION_SEARCH_INPUT_SELECTOR = `[${SESSION_SEARCH_INPUT_ATTR}]`

/** Focuses the session list's own search field, wherever it is currently mounted. A no-op if it
 *  is not (the `restored` gate in `SessionList.tsx` not yet true, or the nav hidden/`inert`). */
export function focusSessionSearchInput(): void {
  document.querySelector<HTMLInputElement>(SESSION_SEARCH_INPUT_SELECTOR)?.focus()
}
