// The one place a Session's Stages and agents are counted: the chat card header, the Agents panel header and the composer pill
// all read these, so they cannot disagree. Pure, with no UI imports, so the state layer can use it too.
import type { SubagentSummary } from '../../../shared/model'
import { summarizeSubagentStatuses, type SubagentRowStatus } from './subagentStatus'
import { stageKeyOf } from './viewModel/numbering'

export interface StageCounts {
  stageCount: number
  agentCount: number
  /** Agents by status across every Stage. */
  statusCounts: Record<SubagentRowStatus, number>
}

/** The pill's counts: every status the pill and its hover card word. */
export type PillCounts = Record<'running' | 'finished' | 'exited' | 'failed' | 'cancelled', number>

type CountedSummary = Pick<SubagentSummary, 'toolCallId' | 'stageKey' | 'status'>

/** Each Stage as the statuses of its agents, in start order. */
export function countStagesAndAgents(stages: readonly (readonly SubagentRowStatus[])[]): StageCounts {
  const flat = stages.flat()
  return { stageCount: stages.length, agentCount: flat.length, statusCounts: summarizeSubagentStatuses(flat) }
}

/** A Stage is the owning message (`stageKey`), or the launching call while no message was seen: the same identity the card and the panel group by. */
function stagesOf(summaries: readonly CountedSummary[]): Map<string, SubagentRowStatus[]> {
  const stages = new Map<string, SubagentRowStatus[]>()
  for (const summary of summaries) {
    const key = stageKeyOf(summary.stageKey, summary.toolCallId)
    const members = stages.get(key)
    if (members) members.push(summary.status)
    else stages.set(key, [summary.status])
  }
  return stages
}

/**
 * The pill's counts. While anything runs they cover the whole list; otherwise only the last Stage is counted, and nothing is
 * returned (no pill) unless that Stage had a failure or an exit, so a failure is never silent and finished work never lingers.
 */
export function countPill(summaries: readonly CountedSummary[]): PillCounts | null {
  const lastSummary = summaries[summaries.length - 1]
  if (!lastSummary) return null
  const stages = stagesOf(summaries)
  const running = summaries.some((summary) => summary.status === 'running')
  const scope = running ? [...stages.values()] : [stages.get(stageKeyOf(lastSummary.stageKey, lastSummary.toolCallId))!]
  const { statusCounts } = countStagesAndAgents(scope)
  if (!running && statusCounts.failed === 0 && statusCounts.exited === 0) return null
  const { finished, exited, failed, cancelled } = statusCounts
  return { running: statusCounts.running, finished, exited, failed, cancelled }
}
