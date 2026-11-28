import { create } from 'zustand'
import type { AgentsGroup } from '../../shared/ipc'

/** The Agents panel's empty state: shown when no Session has an agent left to list. */
export const NO_AGENTS_TEXT = 'No agents running'

// Stable so a store with nothing in it never looks like a changed snapshot to zustand.
export const EMPTY_AGENT_GROUPS: readonly AgentsGroup[] = []

interface AgentsState {
  /** Every live Session's group exactly as Rust sent it, keyed by nothing: `agents:update` is a full replacement. */
  groups: readonly AgentsGroup[]
  apply(groups: readonly AgentsGroup[]): void
}

export const useAgentsStore = create<AgentsState>((set) => ({
  groups: EMPTY_AGENT_GROUPS,
  apply: (groups) => set({ groups })
}))

export function runningAgentCount(group: Pick<AgentsGroup, 'subagents'>): number {
  return group.subagents.filter((agent) => agent.status === 'running').length
}

/** The rail badge's figure: every running agent across every Session. */
export function totalRunningAgents(groups: readonly AgentsGroup[]): number {
  return groups.reduce((total, group) => total + runningAgentCount(group), 0)
}

/** Groups the panel lists: a Session with no agents is hidden, and one with a running agent comes before one without. Rust's order is kept within each half. */
export function visibleAgentGroups(groups: readonly AgentsGroup[]): AgentsGroup[] {
  const listed = groups.filter((group) => group.subagents.length > 0)
  return [...listed.filter((group) => runningAgentCount(group) > 0), ...listed.filter((group) => runningAgentCount(group) === 0)]
}
