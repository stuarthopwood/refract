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
