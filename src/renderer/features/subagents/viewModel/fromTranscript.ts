import type { SubagentSummary } from '../../../../shared/model'
import type { GroupedTranscriptItem } from '../../chat/groupToolItems'
import { chatRowStatus } from '../subagentStatus'
import { deriveScenario, type AgentInput, type StageInput } from './derive'
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

// The summary wins wherever both sources carry a field: it is the live one (ADR 0013).
export function overlay(item: TranscriptSubagentItem, resultSummary: string | undefined, summary: SubagentSummary | undefined): AgentInput {
  return {
    id: item.id,
    toolCallId: item.toolCallId,
    specIndex: item.specIndex,
    name: item.name,
    status: summary ? summary.status : chatRowStatus(item.status),
    startedAt: summary?.startedAt ?? item.startedAt,
    durationMs: summary?.durationMs ?? item.durationMs,
    background: summary?.background,
    role: summary?.role ?? item.role,
    overallGoal: summary?.overallGoal ?? item.overallGoal,
    resultSummary,
    taskSummary: summary?.taskSummary,
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

/** The chat card's entry point over runs `splitSubagentRuns` already found; one stage per run, in order. */
export function fromTranscriptRuns(slots: readonly RunSlot[], summaries: readonly SubagentSummary[]): ChatScenario {
  const bySummary = summaryIndex(summaries)
  const stages = slots.flatMap((slot) => (slot.kind === 'run' ? [toStageInput(slot.items, bySummary)] : []))
  return deriveScenario(stages)
}

/**
 * The chat card's entry point: transcript subagent items are the base and `summaries` overlay the live fields.
 * A summary with no matching item is ignored (the transcript decides what the chat shows); an item with no summary renders from itself.
 */
export function fromTranscript(items: readonly GroupedTranscriptItem[], summaries: readonly SubagentSummary[]): ChatScenario {
  return fromTranscriptRuns(splitSubagentRuns(items), summaries)
}
