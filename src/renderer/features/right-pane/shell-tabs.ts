export type ShellLayout = 'launcher' | 'title-row' | 'tab-bar'

/** Panel and document tabs count alike: none shows the launcher, one a title row, two or more the tab bar. */
export function shellLayout(tabCount: number): ShellLayout {
  return tabCount === 0 ? 'launcher' : tabCount === 1 ? 'title-row' : 'tab-bar'
}

export interface TabSnapshot {
  sessionId: string | null
  keys: ReadonlySet<string>
}

/** A tab newly in the strip takes content focus; a Session switch swaps the document tabs and is not an opening. */
export function isGenuineOpen(previous: TabSnapshot, sessionId: string | null, activeKey: string | null): boolean {
  return activeKey !== null && previous.sessionId === sessionId && !previous.keys.has(activeKey)
}

export type OpenFocusTarget = 'tab' | 'content' | 'none'

/** A keyboard-opened document tab takes focus itself, so Arrow keys and Delete work at once (FR-005); a panel keeps content focus, and a lone tab has no strip button to focus. */
export function openFocusTarget(genuineOpen: boolean, suppressed: boolean, activeKind: 'panel' | 'document' | undefined, layout: ShellLayout): OpenFocusTarget {
  if (!genuineOpen || suppressed) return 'none'
  return activeKind === 'document' && layout === 'tab-bar' ? 'tab' : 'content'
}
