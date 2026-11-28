// The one set of derivations both entry points share, so the chat card and the panel can never disagree on a title or a count.
import type { SubagentRecentStep } from '../../../../shared/model'
import { formatElapsed } from '../../chat/formatElapsed'
import { extractContextLabel, resolveStageDependencies, stageOutcomeText, stageRollupText, stripShellSetup, type StageDependency } from '../../chat/stageMeta'
import { overallStatus } from '../../chat/subagentChainStatus'
import { formatHeaderStats } from '../card/headerStats'
import { summarizeSubagentStatuses, type SubagentRowStatus } from '../subagentStatus'
import { cleanTitle } from './cleanTitle'
import { numberStages, type StageNumbers } from './numbering'
import type { ChatScenario, StageItem, SubAgentItem, SubStep } from './types'

// `endedAt` is undefined unless every agent has both `startedAt` and `durationMs`, so a member with no duration cannot understate the total.
function stageTimeRange(items: readonly { startedAt?: number; durationMs?: number }[]): { startedAt?: number; endedAt?: number } {
  let startedAt: number | undefined
  let maxEnd: number | undefined
  let everyItemSettled = true
  for (const item of items) {
    if (item.startedAt != null && (startedAt === undefined || item.startedAt < startedAt)) startedAt = item.startedAt
    if (item.startedAt == null || item.durationMs == null) {
      everyItemSettled = false
      continue
    }
    const end = item.startedAt + item.durationMs
    if (maxEnd === undefined || end > maxEnd) maxEnd = end
  }
  return { startedAt, endedAt: everyItemSettled ? maxEnd : undefined }
}

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
  /** The one-line summary of the agent's result (its first useful line), already extracted by the entry point. */
  resultSummary?: string
  taskSummary?: string
  /** The synthesised one-line card summary (FR-217); preferred over the result and task summaries. */
  cardSummary?: string
  filesTouched?: string[]
  recentSteps?: SubagentRecentStep[]
}

/** One Stage as an entry point groups it. */
export interface StageInput {
  id: string
  /** The shared `task()` context, when the source has one. */
  context?: string
  /** The `agent://` ids this Stage's source text names, already extracted by the entry point. */
  agentRefs: readonly string[]
  agents: AgentInput[]
}

// `clean: false` keeps the raw command; the card shows the stripped one and the raw one stays a tooltip (FR-177).
function stepLabel(step: SubagentRecentStep, clean = true): string {
  const target = clean && step.target ? stripShellSetup(step.target) : step.target
  return [step.intent ?? step.tool, target].filter(Boolean).join(' ')
}

function deriveSubSteps(steps: readonly SubagentRecentStep[]): SubStep[] {
  return steps.map((step): SubStep => {
    const label = stepLabel(step)
    const rawLabel = stepLabel(step, false)
    return {
      label,
      ...(rawLabel !== label ? { rawLabel } : {}),
      status: step.endMs != null ? 'done' : 'running',
      ...(step.isError ? { isError: true } : {})
    }
  })
}

/** Exported for its own tests; the entry points reach it through `deriveScenario`. */
export function deriveAgent(input: AgentInput, triggeredBy: string | undefined): SubAgentItem {
  const whatItDid = input.cardSummary ?? input.resultSummary ?? input.taskSummary
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

/**
 * Builds the scenario for `stages`, in order. Pure: the same input always yields an equal result. `numbers` is the Session's
 * numbering; without it the Stages are numbered among themselves.
 */
export function deriveScenario(stages: readonly StageInput[], numbers?: StageNumbers): ChatScenario {
  const stageNumbers = numbers ?? numberStages(stages.map((input) => input.agents[0]!.toolCallId))
  const drafts: StageDraft[] = stages.map((input, index) => ({
    stageIndex: stageNumbers.get(input.agents[0]!.toolCallId) ?? index + 1,
    items: input.agents,
    dependencies: [],
    input
  }))
  resolveStageDependencies(
    drafts,
    (item: AgentInput) => item.name,
    (draft) => draft.input.agentRefs
  )

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
    const outcomeSummary = agents.length === 1 ? derived[0]!.whatItDid : stageOutcomeText(counts, agents.length, status === 'running')
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
      ...(overallGoal ? { overallGoal } : {}),
      ...(outcomeSummary ? { outcomeSummary } : {}),
      ...(startedAt != null ? { startedAt } : {}),
      ...(durationMs != null ? { durationMs, duration: formatElapsed(durationMs) } : {})
    }
  })

  return { ...deriveHeader(stageItems), stages: stageItems }
}

/** The whole-run roll-up over already-derived Stages, so a surface holding only Stages (the chat's per-turn group) needs no second derivation. */
export function deriveHeader(stages: readonly StageItem[]): Omit<ChatScenario, 'stages'> {
  const agents = stages.flatMap((stage) => stage.agents)
  const totals = summarizeSubagentStatuses(agents.map((agent) => agent.status))
  const { startedAt, endedAt } = stageTimeRange(agents)
  const totalDurationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const overallGoal = stages.find((stage) => stage.overallGoal)?.overallGoal
  const headerStats = formatHeaderStats({ stageCount: stages.length, agentCount: agents.length, statusCounts: totals })
  return {
    headerStats,
    rollupText: stageRollupText(totals, agents.length, totals.running > 0),
    ...(overallGoal ? { overallGoal } : {}),
    ...(startedAt != null ? { startedAt } : {}),
    ...(totalDurationMs != null ? { totalDurationMs, totalDuration: formatElapsed(totalDurationMs) } : {})
  }
}
