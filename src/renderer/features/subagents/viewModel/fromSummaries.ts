import type { SubagentSummary } from '../../../../shared/model'
import { extractAgentRefs } from '../../chat/stageMeta'
import { deriveScenario, type StageInput } from './derive'
import type { ChatScenario } from './types'

function toStageInput(run: readonly SubagentSummary[]): StageInput {
  return {
    id: `stage:${run[0]!.toolCallId}`,
    // A summary carries no context and no task text, so the title falls back to the names and `agent://` refs come from names alone.
    agentRefs: extractAgentRefs(run.map((item) => item.nameOrTask).join('\n')),
    agents: run.map((item) => ({
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
    }))
  }
}

/** The panel's entry point: readout summaries alone, one Stage per contiguous run of one `toolCallId`. */
export function fromSummaries(summaries: readonly SubagentSummary[]): ChatScenario {
  const runs: SubagentSummary[][] = []
  for (const summary of summaries) {
    const last = runs[runs.length - 1]
    if (last && last[0]!.toolCallId === summary.toolCallId) last.push(summary)
    else runs.push([summary])
  }
  return deriveScenario(runs.map(toStageInput))
}
