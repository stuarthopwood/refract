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
