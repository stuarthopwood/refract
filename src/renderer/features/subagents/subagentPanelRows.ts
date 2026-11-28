// The Agents panel's rows: one group per Session, its running agents and its failures listed, its successful finishes folded into
// one line (#490, FR-205, FR-206). Pure so the grouping, the fold and the focus rules are tested without a DOM.
import type { AgentsGroup } from '../../../shared/ipc'
import type { SubagentSummary } from '../../../shared/model'
import { NO_AGENTS_TEXT, runningAgentCount, visibleAgentGroups } from '@/state/agents-store'
import { formatElapsed } from '../chat/formatElapsed'
import { agentKey } from './viewModel/fromTranscript'

/** Anything the panel can hold focus on; focus recovery only needs to know whether it is still on screen. */
export interface PanelRow {
  key: string
}

export interface AgentRow extends PanelRow {
  kind: 'agent'
  summary: SubagentSummary
}

/** The one line that stands for every successfully finished agent of a Session. */
export interface FinishedRow extends PanelRow {
  kind: 'finished'
  count: number
}

export interface GroupRows extends PanelRow {
  sessionId: string
  name: string
  repositoryName?: string
  running: number
  rows: (AgentRow | FinishedRow)[]
}

/** The chat card's "Show in panel" toggle key for a Stage; kept apart from the card's own `card:` key. */
export const panelStageToggleId = (stageId: string): string => `panel:${stageId}`

export const agentsGroupKey = (sessionId: string): string => `group:${sessionId}`
export const agentRowKey = (sessionId: string, summary: Pick<SubagentSummary, 'toolCallId' | 'specIndex'>): string => `${sessionId}|${agentKey(summary.toolCallId, summary.specIndex)}`

export const finishedText = (count: number): string => `${count} finished`
export const runningText = (count: number): string => `${count} running`

/** The live region's text: the running total across every Session, which is also the empty state when it is zero. */
export function agentsStatusText(totalRunning: number): string {
  if (totalRunning === 0) return NO_AGENTS_TEXT
  return `${totalRunning} ${totalRunning === 1 ? 'agent' : 'agents'} running`
}

/**
 * One group's rows: running agents first, then failed, cancelled, exited and parked ones, each in Rust's order, then the fold.
 * Only a successful finish folds; anything else needs the developer's eye, so it keeps a row of its own.
 */
export function foldGroup(group: AgentsGroup): GroupRows {
  const running = group.subagents.filter((agent) => agent.status === 'running')
  const needsAttention = group.subagents.filter((agent) => agent.status !== 'running' && agent.status !== 'finished')
  const finished = group.subagents.length - running.length - needsAttention.length
  const rows: GroupRows['rows'] = [...running, ...needsAttention].map((summary) => ({ kind: 'agent', key: agentRowKey(group.sessionId, summary), summary }))
  if (finished > 0) rows.push({ kind: 'finished', key: `finished|${group.sessionId}`, count: finished })
  return { key: agentsGroupKey(group.sessionId), sessionId: group.sessionId, name: group.name, repositoryName: group.repositoryName, running: runningAgentCount(group), rows }
}

/** Every listed Session's group: running Sessions first, Sessions with nothing to show left out. */
export function buildGroupRows(groups: readonly AgentsGroup[]): GroupRows[] {
  return visibleAgentGroups(groups).map(foldGroup)
}

/** What holds focus now: every header, and the agent rows of each group that is open. The fold line is not a control. */
export function panelFocusRows(groups: readonly GroupRows[], collapsed: ReadonlySet<string>): PanelRow[] {
  return groups.flatMap((group) => [{ key: group.key }, ...(collapsed.has(group.sessionId) ? [] : group.rows.filter((row) => row.kind === 'agent'))])
}

/** The next collapsed set after the developer toggles one group; a group is open until they close it, and nothing is persisted. */
export function toggleGroupCollapsed(collapsed: ReadonlySet<string>, sessionId: string): Set<string> {
  const next = new Set(collapsed)
  if (!next.delete(sessionId)) next.add(sessionId)
  return next
}

type TimedSummary = Pick<SubagentSummary, 'status' | 'startedAt' | 'durationMs'>

/** A running agent ticks from its start (clamped at zero for a clock behind `startedAt`); a settled one reports the duration Rust recorded. */
export function agentElapsedText(summary: TimedSummary, now: number): string | undefined {
  const ms = summary.status === 'running' ? Math.max(0, now - summary.startedAt) : summary.durationMs
  return ms === undefined ? undefined : formatElapsed(ms)
}

export interface Selection {
  selectedId: string | null
  selectedKey: string | null
}

/** The selected agent of the bound Session: the `toolCallId:specIndex` key when it still names one, else the selected id. */
export function findSelectedSummary(subagents: readonly SubagentSummary[], { selectedId, selectedKey }: Selection): SubagentSummary | null {
  const byKey = selectedKey ? subagents.find((agent) => agentKey(agent.toolCallId, agent.specIndex) === selectedKey) : undefined
  if (byKey) return byKey
  return selectedId ? (subagents.find((agent) => agent.id === selectedId) ?? null) : null
}

/** The row key of the selected agent, or null when none is selected in the bound Session or it has folded into "N finished". */
export function selectedRowKey(groups: readonly GroupRows[], boundSessionId: string | null, selection: Selection): string | null {
  const group = groups.find((candidate) => candidate.sessionId === boundSessionId)
  if (!group) return null
  const agents = group.rows.filter((row): row is AgentRow => row.kind === 'agent')
  const selected = findSelectedSummary(
    agents.map((row) => row.summary),
    selection
  )
  return selected ? agentRowKey(group.sessionId, selected) : null
}

/** A row in the bound Session only selects; one in another Session rebinds the panel to that Session first, which clears the old selection. */
export function selectionRoute(boundSessionId: string | null, groupSessionId: string): 'select' | 'rebind' {
  return boundSessionId === groupSessionId ? 'select' : 'rebind'
}

export interface PendingFocus {
  pendingFocusKey: string | null
  pendingFocusId: string | null
}

/** The key to focus for an opener's request: the agent's own row, or its Session's header when the agent is folded into "N finished"; null when it is not listed. */
export function pendingFocusTarget(groups: readonly GroupRows[], sessionId: string | null, pending: PendingFocus): string | null {
  const group = groups.find((candidate) => candidate.sessionId === sessionId)
  if (!group || (!pending.pendingFocusKey && !pending.pendingFocusId)) return null
  const row = group.rows.find((candidate): candidate is AgentRow => {
    if (candidate.kind !== 'agent') return false
    return pending.pendingFocusKey ? agentKey(candidate.summary.toolCallId, candidate.summary.specIndex) === pending.pendingFocusKey : candidate.summary.id === pending.pendingFocusId
  })
  if (row) return row.key
  return group.rows.some((candidate) => candidate.kind === 'finished') ? group.key : null
}

/** True when a row the developer was on has been pruned and nothing else holds focus, so it fell to the page body: only then does focus move to the panel heading, never away from another control (#1085, FR-203). */
export function focusLostToPrune(focusedKey: string | null, rows: readonly PanelRow[], activeIsBody: boolean): boolean {
  return focusedKey !== null && activeIsBody && !rows.some((row) => row.key === focusedKey)
}
