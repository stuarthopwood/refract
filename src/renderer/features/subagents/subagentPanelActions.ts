// The Agents panel's side effects as plain functions over injected fakes, so the repo's no-jsdom tests can reach them (#490).
import { groupScrollStep, selectionRoute, type AgentRow, type GroupRows } from './subagentPanelRows'
import { agentKey } from './viewModel/fromTranscript'

interface Rect {
  getBoundingClientRect(): { top: number }
}

/** Scrolls only the tree wrapper, never an ancestor: `scrollIntoView` would also move the pane around the panel. */
export function scrollHostToGroup(host: Rect & { scrollTop: number }, group: Rect): void {
  host.scrollTop += group.getBoundingClientRect().top - host.getBoundingClientRect().top
}

export interface GroupScrollEffects {
  expand(): void
  scroll(): void
  clear(): void
}

/** A closed group opens first and the request stays pending (the re-render consumes it); an open one scrolls; an unlisted one is dropped. */
export function consumeGroupScroll(groups: readonly GroupRows[], collapsed: ReadonlySet<string>, sessionId: string, effects: GroupScrollEffects): void {
  const step = groupScrollStep(groups, collapsed, sessionId)
  if (step === 'expand') {
    effects.expand()
    return
  }
  if (step === 'scroll') effects.scroll()
  effects.clear()
}

export interface SelectEffects {
  selectSubagent(subagentId: string, key: string): unknown
  openPanel(sessionId: string, options: { selectSubagentId: string; selectSubagentKey: string }): void
}

/** A row selects (its live stream opens); one in another Session rebinds the panel to that Session as it does. */
export function selectAgentRow(boundSessionId: string | null, groupSessionId: string, row: AgentRow, effects: SelectEffects): void {
  const key = agentKey(row.summary.toolCallId, row.summary.specIndex)
  if (selectionRoute(boundSessionId, groupSessionId) === 'select') void effects.selectSubagent(row.summary.id, key)
  else effects.openPanel(groupSessionId, { selectSubagentId: row.summary.id, selectSubagentKey: key })
}
