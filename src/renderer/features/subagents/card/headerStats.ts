// The Subagents card header's text and segment states as pure functions over the view-model's counts (FR-146),
// so the chat card and the panel word them identically and the wording is testable without rendering.
import type { ProgressSegmentState } from '@/components/ProgressStrip'
import { formatElapsed } from '../../chat/formatElapsed'
import { unsettledRollupText } from '../../chat/stageMeta'
import { SUBAGENT_STATUS_LABEL, type SubagentRowStatus } from '../subagentStatus'
import type { StageItem } from '../viewModel'

export interface HeaderCounts {
  stageCount: number
  agentCount: number
  /** Agents by status across every Stage. */
  statusCounts: Record<SubagentRowStatus, number>
}

const plural = (count: number, singular: string, many: string) => `${count} ${count === 1 ? singular : many}`

/** "3 stages, 5 agents, 1 running"; singular and plural handled, a part with a zero count (such as "0 running") dropped. */
export function formatHeaderStats({ stageCount, agentCount, statusCounts }: HeaderCounts): string {
  return [plural(stageCount, 'stage', 'stages'), plural(agentCount, 'agent', 'agents'), unsettledRollupText(statusCounts)].filter((part) => part.length > 0).join(', ')
}

/** The visible text beside the bar: "2/4 stages done". */
export function formatProgressText(done: number, total: number): string {
  return `${done}/${total} stages done`
}

/** The progressbar's accessible value text: "2 of 4 stages done". */
export function formatProgressValueText(done: number, total: number): string {
  return `${done} of ${plural(total, 'stage', 'stages')} done`
}

/** Done only for a finished Stage and running only for a running one; a failed, cancelled, exited or parked Stage is not done, so it keeps the queued look. */
export function stageSegmentState(status: SubagentRowStatus): ProgressSegmentState {
  if (status === 'finished') return 'done'
  return status === 'running' ? 'running' : 'queued'
}

export function stageSegmentStates(stages: readonly Pick<StageItem, 'status'>[]): ProgressSegmentState[] {
  return stages.map((stage) => stageSegmentState(stage.status))
}

/** The header trigger's accessible name: the ticking duration is left out while running so the name does not change every second. */
export function formatHeaderTriggerLabel(headerStats: string, status: SubagentRowStatus, durationMs: number | undefined): string {
  const parts = ['Subagents', headerStats]
  if (status !== 'finished') parts.push(SUBAGENT_STATUS_LABEL[status])
  if (status !== 'running' && durationMs != null) parts.push(formatElapsed(durationMs))
  return parts.join(', ')
}
