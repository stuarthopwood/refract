import { create } from 'zustand'
import { useSubagentPanelStore } from './subagent-store'
import type { AgentsGroup } from '../../shared/ipc'

/** The Agents panel's empty state: shown when no Session has an agent left to list. */
export const NO_AGENTS_TEXT = 'No agents running'

// Stable so a store with nothing in it never looks like a changed snapshot to zustand.
export const EMPTY_AGENT_GROUPS: readonly AgentsGroup[] = []

// Rust sends plain JSON, so a recursive key walk is enough to tell an unchanged group from a changed one.
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => structurallyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

interface AgentsState {
  /** Every live Session's group exactly as Rust sent it, keyed by nothing: `agents:update` is a full replacement. */
  groups: readonly AgentsGroup[]
  apply(groups: readonly AgentsGroup[]): void
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  groups: EMPTY_AGENT_GROUPS,
  apply: (incoming) => {
    if (!Array.isArray(incoming)) return
    const previous = new Map(get().groups.map((group) => [group.sessionId, group]))
    // Unchanged groups keep their identity so memoised rows skip re-rendering on every tick.
    const groups = incoming.map((group) => {
      const old = previous.get(group.sessionId)
      return old && structurallyEqual(old, group) ? old : group
    })
    const current = get().groups
    if (groups.length !== current.length || groups.some((group, index) => group !== current[index])) set({ groups })
    // The selection follows its Session: archive or delete removes the group, and the panel stays open (FR-204).
    const bound = useSubagentPanelStore.getState().sessionId
    if (bound && !groups.some((group) => group.sessionId === bound)) {
      useSubagentPanelStore.getState().clearSelectionForSession(bound)
    }
  }
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
  const running: AgentsGroup[] = []
  const idle: AgentsGroup[] = []
  for (const group of groups) {
    if (group.subagents.length === 0) continue
    if (group.subagents.some((agent) => agent.status === 'running')) running.push(group)
    else idle.push(group)
  }
  return [...running, ...idle]
}
