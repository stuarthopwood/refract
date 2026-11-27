import type { SubagentSummary } from '../../../../shared/model'
import { extractAgentRefs } from '../../chat/stageMeta'
import { deriveScenario, type AgentInput, type StageInput } from './derive'
import { agentKey, overlay } from './fromTranscript'
import { runFacts } from './runFacts'
import type { TranscriptSubagentItem } from './runs'
import type { ChatScenario } from './types'

function fromSummaryOnly(item: SubagentSummary): AgentInput {
  return {
    id: item.id,
    toolCallId: item.toolCallId,
    specIndex: item.specIndex,
    name: item.nameOrTask,
    status: item.status,
    startedAt: item.startedAt,
    durationMs: item.durationMs,
    background: item.background,
    role: item.role,
    overallGoal: item.overallGoal,
    taskSummary: item.taskSummary,
    filesTouched: item.filesTouched,
    recentSteps: item.recentSteps
  }
}

// A member with a transcript item reads through the same overlay the chat card uses, so the two surfaces share one name, goal and outcome.
function toStageInput(run: readonly SubagentSummary[], itemsByKey: ReadonlyMap<string, TranscriptSubagentItem>): StageInput {
  const matched = run.map((summary) => itemsByKey.get(agentKey(summary.toolCallId, summary.specIndex)))
  const runItems = matched.filter((item): item is TranscriptSubagentItem => item !== undefined)
  const facts = runItems.length > 0 ? runFacts(runItems) : undefined
  const agents = run.map((summary, index) => {
    const item = matched[index]
    // The panel's selection and pending focus address an agent by its summary id, never the transcript item's.
    return item ? { ...overlay(item, facts?.resultSummaries[runItems.indexOf(item)], summary), id: summary.id } : fromSummaryOnly(summary)
  })
  // A summary carries no context and no task text, so a member without an item contributes its name to the `agent://` refs.
  const unmatchedNames = run.filter((_, index) => !matched[index]).map((summary) => summary.nameOrTask)
  return {
    id: `stage:${run[0]!.toolCallId}`,
    context: facts?.context,
    agentRefs: [...new Set([...(facts?.agentRefs ?? []), ...extractAgentRefs(unmatchedNames.join('\n'))])],
    agents
  }
}

/**
 * The panel's entry point: readout summaries, one Stage per contiguous run of one `toolCallId`. `items` are the transcript's subagent
 * items; where one matches a summary it supplies the context, task and result text the summary lacks (ADR 0013).
 */
export function fromSummaries(summaries: readonly SubagentSummary[], items: readonly TranscriptSubagentItem[] = []): ChatScenario {
  const itemsByKey = new Map(items.map((item) => [agentKey(item.toolCallId, item.specIndex), item]))
  const runs: SubagentSummary[][] = []
  for (const summary of summaries) {
    const last = runs[runs.length - 1]
    if (last && last[0]!.toolCallId === summary.toolCallId) last.push(summary)
    else runs.push([summary])
  }
  return deriveScenario(runs.map((run) => toStageInput(run, itemsByKey)))
}
