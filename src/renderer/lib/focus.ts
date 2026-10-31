// Shared "always-connected" focus fallback (WCAG 2.1 AA 2.4.3 focus-visibility).
export function focusSessionsNav(): boolean {
  const nav = document.querySelector<HTMLElement>('nav[aria-label="Sessions"]')
  if (nav && !nav.closest('[inert]')) {
    nav.focus()
    return true
  }
  const pane = document.querySelector<HTMLElement>('[data-session-pane]')
  if (pane) {
    focusPaneContent(pane)
    return true
  }
  const handle = document.querySelector<HTMLElement>('[aria-label="Resize session list"]')
  if (!handle) return false
  handle.focus()
  return true
}

// Falls back to the message box on the off chance the SessionList hasn't.
export function focusSettingsEntry(): void {
  const settingsButton = document.querySelector<HTMLElement>('button[aria-label="Settings"]')
  if (settingsButton) {
    settingsButton.focus()
    return
  }
  document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

// The name button's accessible name changes with the GitHub sign-in state.
export function focusProfileItemName(): void {
  const nameButton = document.querySelector<HTMLElement>('[data-profile-name-button]')
  if (nameButton) {
    nameButton.focus()
    return
  }
  document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

export function focusPaneContent(container: HTMLElement | null): void {
  if (!container) return
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
  if (textarea) {
    textarea.focus()
    return
  }
  if (focusStopBanner(container)) return
  container.focus()
}

/** Focuses the banner's first enabled button, else the banner itself; false when there is no banner. */
export function focusStopBanner(container: HTMLElement | null): boolean {
  const bannerButton = container?.querySelector<HTMLElement>(
    '[data-pane-banner] button:not(:disabled), [data-pane-banner] [href]'
  )
  if (bannerButton) {
    bannerButton.focus()
    return true
  }
  const banner = container?.querySelector<HTMLElement>('[data-pane-banner][tabindex="-1"]')
  if (!banner) return false
  banner.focus()
  return true
}

export function focusSessionPane(sessionId: string): boolean {
  const container = document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`)
  focusPaneContent(container)
  return !!container
}

// After closing the last open pane, the closed Session's own row open button is the first-choice target.
export function focusSessionRow(sessionId: string): boolean {
  const button = document.querySelector<HTMLElement>(`[data-session-open="${CSS.escape(sessionId)}"]`)
  if (!button || button.closest('[inert]')) return false
  button.focus()
  return true
}

// Removing a repository unmounts its whole group at once.
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
  // The first-run screen mounts after this runs; park focus on its heading so it is never on <body>.
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
    if (!parked?.isConnected) {
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
    if (!parked) focusSessionsNav()
  }
  tick()
}

/** Chromium may not blur a focused element when it becomes `disabled`. */
export function isFocusStranded(active: Element | null, root: HTMLElement | null): boolean {
  return (
    !active ||
    active === document.body ||
    !active.isConnected ||
    (active instanceof HTMLElement && active.matches(':disabled') && !!root?.contains(active))
  )
}
