// Shared "always-connected" focus fallback (WCAG 2.1 AA 2.4.3 focus-visibility). Several
// SessionList/ChatPane actions (archive, restore, delete) unmount the element that currently
// holds focus, sometimes asynchronously and sometimes along with its whole surrounding group
// (e.g. restoring the last archived Session also unmounts the Archived <Collapsible>). The
// Sessions nav root (src/renderer/features/sessions/SessionList.tsx) is the one element
// guaranteed to outlive every row, group, and dialog it contains, so it is always a safe final
// fallback when no better, still-connected neighbour exists.
export function focusSessionsNav(): void {
  document.querySelector<HTMLElement>('nav[aria-label="Sessions"]')?.focus()
}

// High remediation (a11y, spec 004): leaving the Settings screen via "Back to chat" unmounts it
// and remounts the SessionList+ChatPane workspace fresh (App.tsx swaps the whole main area on
// `view`), so there is no ref to a still-connected element the way DeleteDialog's own fallback
// chain has -- the Settings entry button has to be queried fresh after the remount, the same
// "always-connected" idea as `focusSessionsNav` above applied to an element that is reliably
// there once the workspace view is showing again. Falls back to the message box on the off
// chance the SessionList hasn't (re)mounted yet for any reason, so focus never silently drops to
// `<body>` either way.
export function focusSettingsEntry(): void {
  const settingsButton = document.querySelector<HTMLElement>('button[aria-label="Settings"]')
  if (settingsButton) {
    settingsButton.focus()
    return
  }
  document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

// Post-build review fix (D3, Stuart 2026-10-05): leaving the Manage sessions screen via "Back
// to chat" has the identical remount problem -- it is reached from the profile menu, not
// SessionList.tsx, so the control to return to is the profile item's own name button, not the
// Settings cog above. The name button's accessible name is dynamic (the signed-in account's
// display name, "Sign in", or "GitHub CLI not found"), so it cannot be queried by
// `aria-label` the way `focusSettingsEntry` queries the cog -- `ProfileItem.tsx` instead marks
// it with a stable `data-profile-name-button` attribute for exactly this query.
export function focusProfileItemName(): void {
  const nameButton = document.querySelector<HTMLElement>('[data-profile-name-button]')
  if (nameButton) {
    nameButton.focus()
    return
  }
  document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

// Post-build review fix (D2, Stuart 2026-10-05): opening a Session from the Manage sessions
// screen (spec 008 FR-025) switches back to the chat view and unmounts this screen entirely --
// unlike SessionList.tsx's own row click, which never unmounts anything (the nav and chat are
// both already visible, so the clicked row simply keeps the focus it already had). There is no
// single "the clicked row" to return focus to here, so this lands on the message box instead --
// the same first enabled `textarea` `ChatPane.tsx`'s own `focusPaneContent` falls back to
// first, and the one control a freshly-opened Session reliably has.
export function focusMessageBox(): void {
  document.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus()
}
