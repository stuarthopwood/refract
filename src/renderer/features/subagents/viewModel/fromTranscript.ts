import type { SubagentSummary } from '../../../../shared/model'
import type { GroupedTranscriptItem } from '../../chat/groupToolItems'
import { chatRowStatus } from '../subagentStatus'
import { deriveScenario, type AgentInput, type StageInput } from './derive'
import type { StageNumbers } from './numbering'
import { runFacts } from './runFacts'
import { splitSubagentRuns, type RunSlot, type TranscriptSubagentItem } from './runs'
import type { ChatScenario } from './types'

/** The key a transcript item and its readout summary share. */
export function agentKey(toolCallId: string, specIndex: number): string {
  return `${toolCallId}:${specIndex}`
}

function summaryIndex(summaries: readonly SubagentSummary[]): Map<string, SubagentSummary> {
  return new Map(summaries.map((summary) => [agentKey(summary.toolCallId, summary.specIndex), summary]))
}

/**
 * The live summary wins wherever both sources carry a field (ADR 0013), with one exception: a still-running summary never reopens an
 * agent the transcript has already settled, so a late or stale registry entry cannot make a finished agent run again.
 */
export function overlay(item: TranscriptSubagentItem, resultSummary: string | undefined, summary: SubagentSummary | undefined): AgentInput {
  const itemStatus = chatRowStatus(item.status)
  const status = summary && !(summary.status === 'running' && itemStatus !== 'running') ? summary.status : itemStatus
  return {
    id: item.id,
    toolCallId: item.toolCallId,
    specIndex: item.specIndex,
    name: item.name,
    status,
    startedAt: summary?.startedAt ?? item.startedAt,
    durationMs: summary?.durationMs ?? item.durationMs,
    background: summary?.background,
    role: summary?.role ?? item.role,
    overallGoal: summary?.overallGoal ?? item.overallGoal,
    resultSummary,
    taskSummary: summary?.taskSummary,
    cardSummary: summary?.cardSummary,
    filesTouched: summary?.filesTouched,
    recentSteps: summary?.recentSteps
  }
}

function toStageInput(items: readonly TranscriptSubagentItem[], summaries: ReadonlyMap<string, SubagentSummary>): StageInput {
  const { context, agentRefs, resultSummaries } = runFacts(items)
  return {
    id: `stage:${items[0]!.id}`,
    context,
    agentRefs,
    agents: items.map((item, index) => overlay(item, resultSummaries[index], summaries.get(agentKey(item.toolCallId, item.specIndex))))
  }
}

/** The chat card's entry point over runs `splitSubagentRuns` already found; one stage per run, in order. `numbers` is the Session's Stage numbering. */
export function fromTranscriptRuns(slots: readonly RunSlot[], summaries: readonly SubagentSummary[], numbers?: StageNumbers): ChatScenario {
  const bySummary = summaryIndex(summaries)
  const stages = slots.flatMap((slot) => (slot.kind === 'run' ? [toStageInput(slot.items, bySummary)] : []))
  return deriveScenario(stages, numbers)
}

/**
 * The chat card's entry point: transcript subagent items are the base and `summaries` overlay the live fields.
 * A summary with no matching item is ignored (the transcript decides what the chat shows); an item with no summary renders from itself.
 */
export function fromTranscript(items: readonly GroupedTranscriptItem[], summaries: readonly SubagentSummary[], numbers?: StageNumbers): ChatScenario {
  return fromTranscriptRuns(splitSubagentRuns(items), summaries, numbers)
}
