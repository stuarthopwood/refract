// The one set of derivations both entry points share, so the chat card and the panel can never disagree on a title or a count.
import type { SubagentRecentStep } from '../../../../shared/model'
import { formatElapsed } from '../../chat/formatElapsed'
import {
  extractContextLabel,
  extractResultSummary,
  resolveStageDependencies,
  stageRollupText,
  unsettledRollupText,
  type StageDependency
} from '../../chat/stageMeta'
import { overallStatus, stageTimeRange } from '../../chat/subagentChainStatus'
import { summarizeSubagentStatuses, type SubagentRowStatus } from '../subagentStatus'
import { cleanTitle } from './cleanTitle'
import type { ChatScenario, StageItem, SubAgentItem, SubStep } from './types'

/** One agent, already merged from whatever sources the entry point has. */
export interface AgentInput {
  id: string
  toolCallId: string
  specIndex: number
  name: string
  status: SubagentRowStatus
  startedAt?: number
  durationMs?: number
  background?: boolean
  role?: string
  overallGoal?: string
  /** The raw result text; its first line becomes `whatItDid`. */
  result?: string
  taskSummary?: string
  filesTouched?: string[]
  recentSteps?: SubagentRecentStep[]
}

/** One Stage as an entry point groups it. */
export interface StageInput {
  id: string
  /** The shared `task()` context, when the source has one. */
  context?: string
  /** The text scanned for `agent://` references, which differs by source. */
  refText: string
  agents: AgentInput[]
}

function stepLabel(step: SubagentRecentStep): string {
  return [step.intent ?? step.tool, step.target].filter(Boolean).join(' ')
}

function deriveSubSteps(steps: readonly SubagentRecentStep[]): SubStep[] {
  return steps.map((step) => ({
    label: stepLabel(step),
    status: step.endMs != null ? 'done' : 'running',
    ...(step.isError ? { isError: true } : {})
  }))
}

function deriveAgent(input: AgentInput, triggeredBy: string | undefined): SubAgentItem {
  const whatItDid = (input.result != null ? extractResultSummary(input.result) : undefined) ?? input.taskSummary
  const steps = input.recentSteps ?? []
  const lastStep = steps[steps.length - 1]
  const subSteps = steps.length > 0 ? deriveSubSteps(steps).map((s) => (input.status === 'running' ? s : { ...s, status: 'done' as const })) : undefined
  return {
    id: input.id,
    key: `${input.toolCallId}:${input.specIndex}`,
    toolCallId: input.toolCallId,
    specIndex: input.specIndex,
    name: input.name,
    status: input.status,
    ...(input.role ? { role: input.role } : {}),
    ...(whatItDid ? { whatItDid } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs, duration: formatElapsed(input.durationMs) } : {}),
    ...(input.startedAt != null ? { startedAt: input.startedAt } : {}),
    ...(input.background ? { background: true } : {}),
    ...(triggeredBy ? { triggeredBy } : {}),
    ...(input.filesTouched && input.filesTouched.length > 0 ? { filesTouched: input.filesTouched } : {}),
    ...(input.status === 'running' && lastStep ? { liveDetail: stepLabel(lastStep) } : {}),
    ...(subSteps ? { subSteps } : {})
  }
}

interface StageDraft {
  stageIndex: number
  items: AgentInput[]
  dependencies: StageDependency[]
  input: StageInput
}

/** Builds the scenario for `stages`, in order. Pure: the same input always yields an equal result. */
export function deriveScenario(stages: readonly StageInput[]): ChatScenario {
  const drafts: StageDraft[] = stages.map((input, index) => ({ stageIndex: index + 1, items: input.agents, dependencies: [], input }))
  resolveStageDependencies(
    drafts,
    (item: AgentInput) => item.name,
    (draft) => draft.input.refText
  )

  const allAgents = stages.flatMap((stage) => stage.agents)
  const stageItems = drafts.map((draft): StageItem => {
    const { input } = draft
    const agents = input.agents
    const counts = summarizeSubagentStatuses(agents.map((agent) => agent.status))
    const status = overallStatus(counts)
    const rollupText = stageRollupText(counts, agents.length, status === 'running')
    const { startedAt, endedAt } = stageTimeRange(agents)
    const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
    const names = agents.map((agent) => agent.name)
    const overallGoal = agents.find((agent) => agent.overallGoal)?.overallGoal
    const rawLabel = input.context ? extractContextLabel(input.context, false) : null
    const triggeredBy = draft.dependencies.length > 0 ? draft.dependencies.map((d) => d.agentId).join(', ') : undefined
    const derived = agents.map((agent) => deriveAgent(agent, triggeredBy))
    const outcomeSummary = agents.length === 1 ? derived[0]!.whatItDid : status === 'running' ? undefined : rollupText
    return {
      id: input.id,
      number: draft.stageIndex,
      cleanTitle: cleanTitle({ overallGoal, context: input.context, names }),
      status,
      counts,
      rollupText,
      isParallel: agents.length > 1,
      isSingleAgent: agents.length === 1,
      dependencies: draft.dependencies,
      agents: derived,
      ...(rawLabel ? { rawLabel } : {}),
      ...(outcomeSummary ? { outcomeSummary } : {}),
      ...(startedAt != null ? { startedAt } : {}),
      ...(durationMs != null ? { durationMs, duration: formatElapsed(durationMs) } : {})
    }
  })

  const totals = summarizeSubagentStatuses(allAgents.map((agent) => agent.status))
  const isRunning = totals.running > 0
  const { startedAt, endedAt } = stageTimeRange(allAgents)
  const totalDurationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const overallGoal = stageItems.length > 0 ? allAgents.find((agent) => agent.overallGoal)?.overallGoal : undefined
  const headerStats = [
    `${stages.length} ${stages.length === 1 ? 'stage' : 'stages'}`,
    `${allAgents.length} ${allAgents.length === 1 ? 'agent' : 'agents'}`,
    unsettledRollupText(totals)
  ]
    .filter((part) => part.length > 0)
    .join(', ')
  return {
    headerStats,
    rollupText: stageRollupText(totals, allAgents.length, isRunning),
    stages: stageItems,
    ...(overallGoal ? { overallGoal } : {}),
    ...(startedAt != null ? { startedAt } : {}),
    ...(totalDurationMs != null ? { totalDurationMs, totalDuration: formatElapsed(totalDurationMs) } : {})
  }
}
