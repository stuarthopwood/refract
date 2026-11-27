// View-model for the Subagents card and panel (ADR 0013), shaped like the redesign mock
// (docs/design/subagents-redesign/src/data/chatScenarios.ts); fields a source cannot supply are omitted.
import type { StageDependency } from '../../chat/stageMeta'
import type { SubagentRowStatus } from '../subagentStatus'

/** One step of an agent's recent activity; `isError` keeps a failed step from reading as success. */
export interface SubStep {
  label: string
  rawLabel?: string // the step before `cd ... &&` / `export ...;` setup was stripped from `label`; tooltip only
  status: 'done' | 'running' | 'pending'
  isError?: boolean
}

/** One agent of a Stage. */
export interface SubAgentItem {
  id: string
  /** `${toolCallId}:${specIndex}`, the key both sources share. */
  key: string
  toolCallId: string
  specIndex: number
  name: string
  role?: string
  /** One-line outcome: the result's first line, else the summary's `taskSummary`. */
  whatItDid?: string
  status: SubagentRowStatus
  durationMs?: number
  duration?: string
  startedAt?: number
  background?: boolean
  /** The earlier agents this Stage names (`agent://` references), joined with ", ". */
  triggeredBy?: string
  /** Not the mock's `filesChanged`: it comes from a rolling window of recent tools, so it is best-effort. */
  filesTouched?: string[]
  liveDetail?: string
  subSteps?: SubStep[]
}

/** One Stage: the agents of one `task()` call (or, in the chat, one run of them). */
export interface StageItem {
  /** `stage:${toolCallId}` for the panel, `stage:${first item id}` for the chat. */
  id: string
  number: number
  rawLabel?: string
  /** A readable title; null when there is no goal, context or shared name, so callers pick a fallback. */
  cleanTitle: string | null
  /** The one agent's outcome for a single-agent Stage, the roll-up for a settled parallel one; absent while running. */
  outcomeSummary?: string
  status: SubagentRowStatus
  counts: Record<SubagentRowStatus, number>
  rollupText: string
  startedAt?: number
  durationMs?: number
  duration?: string
  isParallel: boolean
  isSingleAgent: boolean
  dependencies: StageDependency[]
  /** The synthesised orchestration goal, when one of this Stage's agents carries it. */
  overallGoal?: string
  agents: SubAgentItem[]
}

/** Everything one surface needs to render its Stages. */
export interface ChatScenario {
  overallGoal?: string
  /** "2 stages, 5 agents, 1 running"; singular and plural handled, zero parts dropped. */
  headerStats: string
  /** "3 of 5 done" while anything runs, "5 done" once settled. */
  rollupText: string
  startedAt?: number
  /** Whole-run wall clock; absent until every agent has a duration. */
  totalDurationMs?: number
  totalDuration?: string
  stages: StageItem[]
}
