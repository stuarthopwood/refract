// Shared "always-connected" focus fallback (WCAG 2.1 AA 2.4.3 focus-visibility). Several
// SessionList/ChatPane actions (archive, restore, delete) unmount the element that currently
// holds focus, sometimes asynchronously and sometimes along with its whole surrounding group
// (e.g. restoring the last archived Session also unmounts the Archived <Collapsible>). The
// Sessions nav root (src/renderer/features/sessions/SessionList.tsx) stays MOUNTED for the whole
// app session, but is no longer guaranteed focusable: App.tsx now keeps it `inert` (and
// `aria-hidden`) rather than unmounting it while the session-list panel is collapsed to zero
// width (quality-gate remediation, gate-3, UI N6 / A11y M3), so a stale `inert` ancestor must be
// checked, not just presence in the DOM. Falls back, in order, to whichever Session pane is
// still showing (`focusPaneContent`, same target `focusSessionPane` uses), then to the session-
// list panel's own resize handle -- the one other still-connected, still-focusable control that
// survives a collapsed/inert nav.
export function focusSessionsNav(): void {
  const nav = document.querySelector<HTMLElement>('nav[aria-label="Sessions"]')
  if (nav && !nav.closest('[inert]')) {
    nav.focus()
    return
  }
  const pane = document.querySelector<HTMLElement>('[data-session-pane]')
  if (pane) {
    focusPaneContent(pane)
    return
  }
  document.querySelector<HTMLElement>('[aria-label="Resize session list"]')?.focus()
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
// Settings cog above. The name button's accessible name changes with the GitHub sign-in state
// (the signed-in account's display name, "Sign in", "GitHub CLI not found", or one of several
// other states ProfileItem.tsx's own `accessibleName` computes), so it cannot be queried by a
// fixed `aria-label` the way `focusSettingsEntry` queries the cog -- `ProfileItem.tsx` instead
// marks it with a stable `data-profile-name-button` attribute for exactly this query.
export function focusProfileItemName(): void {
  const nameButton = document.querySelector<HTMLElement>('[data-profile-name-button]')
  if (nameButton) {
    nameButton.focus()
    return
  }
  document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

// Post-build review fix (Phase7PostBuild, HIGH, moved here from ChatPane.tsx): a stopped Session
// (`agent-exited`/`worktree-missing`/`start-failed`) renders MessageInput's textarea `disabled`
// (MessageInput.tsx), so a plain `textarea?.focus()` silently no-ops there. Falls back to the
// stopped banner's own first enabled button/link, and only then to the pane region itself
// (`tabIndex={-1}`) rather than a generic whole-pane DOM scan, which would otherwise land on a
// `ChatHeader` control instead. Shared by ChatPane's own focus-move chord/button and close-pane
// refocus, and by `focusSessionPane` below, which scopes it to one specific pane.
export function focusPaneContent(container: HTMLElement | null): void {
  if (!container) return
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
  if (textarea) {
    textarea.focus()
    return
  }
  const bannerButton = container.querySelector<HTMLElement>(
    '[data-pane-banner] button:not(:disabled), [data-pane-banner] [href]'
  )
  if (bannerButton) {
    bannerButton.focus()
    return
  }
  container.focus()
}

// Post-build review fix (Phase7PostBuild, HIGH): opening a Session from the Manage sessions
// screen (spec 008 FR-025) switches back to the chat view and unmounts this screen entirely --
// unlike SessionList.tsx's own row click, which never unmounts anything (the nav and chat are
// both already visible, so the clicked row simply keeps the focus it already had). There is no
// single "the clicked row" to return focus to here, so this instead targets whichever pane the
// opened (or already-focused) Session actually ended up in -- resolved by the caller AFTER the
// split-store update commits (`useSplitStore.getState().paneSessionIds[focusedIndex]`), never
// the first enabled textarea anywhere in the document (the previous `focusMessageBox`, removed:
// wrong pane whenever a split is open and the OTHER pane is focused, and `<body>` whenever the
// newly-opened Session is stopped). `data-session-pane` is set on ChatPane's own region element.
export function focusSessionPane(sessionId: string): void {
  const container = document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`)
  focusPaneContent(container)
}

// Issue #488 (T108, FR-059, US1/AC14): removing a repository unmounts its whole group at once.
// When another repository remains, its header is the natural landing spot, and the dialog
// captures the group that was adjacent to the removed one before `remove()` ran (passed in as
// `preferredRepositoryId`) so focus returns there rather than to whichever group happens to sort
// first; that capture, or this query, can both miss (closed Collapsible, re-render timing), so
// the first remaining header is always the fallback. When the removed one was the last, App.tsx's
// own `showReadiness` swap replaces the entire SessionList with the Readiness screen in the same
// tick, so there is no repository header, and no Sessions nav either, left to query -- Readiness
// marks its one primary action with `data-readiness-primary` for exactly this case, mirroring
// `focusSettingsEntry`'s stable-marker approach above, and its own heading with
// `data-readiness-root` for the rare case where even Re-check is still disabled (mid-check).
// Every tick first checks that focus hasn't already moved on its own: a Tab or a click on
// Re-check while this is still waiting must never be overridden.
export function focusRepositoryGroupOrReadiness(preferredRepositoryId?: string): void {
  const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-repository-id]'))
  const preferredGroup = preferredRepositoryId
    ? groups.find((group) => group.getAttribute('data-repository-id') === preferredRepositoryId)
    : undefined
  const header = (preferredGroup ?? groups[0])?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]') ?? null
  if (header) {
    header.focus()
    return
  }
  // The first-run screen mounts after this runs and re-runs its readiness checks; its primary
  // action stays disabled (unfocusable) until they pass, so a single focus() would drop focus to
  // <body>. Park focus on the screen's own heading at once so it is never on <body> (a screen
  // reader would announce nothing), then, bounded, upgrade to the primary action when it
  // enables, but only while focus is still on that heading: a Tab or a click on Re-check in the
  // meantime must never be overridden.
  let attempts = 0
  let parked: HTMLElement | null = null
  const tick = (): void => {
    const active = document.activeElement
    if (active !== document.body && active !== null && active !== parked) return
    const primary = document.querySelector<HTMLElement>('[data-readiness-primary]:not(:disabled)')
    if (primary) {
      primary.focus()
      return
    }
    if (!parked) {
      const readinessRoot = document.querySelector<HTMLElement>('[data-readiness-root]')
      if (readinessRoot) {
        readinessRoot.focus()
        parked = readinessRoot
      }
    }
    attempts += 1
    if (attempts < 40) {
      window.setTimeout(tick, 100)
      return
    }
    if (parked) return
    const fallback = document.querySelector<HTMLElement>('[data-readiness-primary]')?.parentElement?.querySelector<HTMLElement>('button:not(:disabled)')
    if (fallback) fallback.focus()
    else focusSessionsNav()
  }
  tick()
}
