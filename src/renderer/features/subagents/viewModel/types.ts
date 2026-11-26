// View-model for the Subagents card and the Subagent panel (ADR 0013). Shaped like the redesign mock
// (`docs/design/subagents-redesign/src/data/chatScenarios.ts`), minus its mock-only scaffolding
// (tab labels, canned reply text); fields the real sources cannot always supply are optional and omitted when unknown.
import type { StageDependency } from '../../chat/stageMeta'
import type { SubagentRowStatus } from '../subagentStatus'

/** One step of an agent's recent activity; `status` follows the mock, `isError` is kept so a failed step is never shown as plain success. */
export interface SubStep {
  label: string
  status: 'done' | 'running' | 'pending'
  isError?: boolean
}

/** One agent of a Stage. */
export interface SubAgentItem {
  /** `SubagentSummary.id` or the transcript item id. */
  id: string
  /** `${toolCallId}:${specIndex}`, the key both sources share. */
  key: string
  toolCallId: string
  specIndex: number
  name: string
  /** Short human role from the synthesis; absent when unknown, never guessed. */
  role?: string
  /** One-line outcome: the result's first line, else the summary's `taskSummary`. */
  whatItDid?: string
  /** Real row status (the mock only knows completed and running). */
  status: SubagentRowStatus
  durationMs?: number
  /** `durationMs` formatted like the rest of the chat ("1m 14s"). */
  duration?: string
  startedAt?: number
  /** A detached background job. */
  background?: boolean
  /** The earlier agents this agent's Stage names (`agent://` references), joined with ", ". */
  triggeredBy?: string
  /**
   * Named `filesTouched`, not the mock's `filesChanged`: the list comes from a rolling window of recent tools,
   * so it is best-effort and never a complete change list.
   */
  filesTouched?: string[]
  /** What a running agent is doing now, from its newest recent step. */
  liveDetail?: string
  subSteps?: SubStep[]
}

/** One Stage: the agents of one `task()` call (or, in the chat, one run of them). */
export interface StageItem {
  /** `stage:${toolCallId}` for the panel, `stage:${first item id}` for the chat, matching the groupers they replace. */
  id: string
  /** 1-based position among the Stages. */
  number: number
  /** The first context line as written, before cleaning; absent without a context. */
  rawLabel?: string
  /** A readable title; null when there is neither a goal, a context nor a shared name, so callers pick their own fallback. */
  cleanTitle: string | null
  /** The one agent's outcome for a single-agent Stage, the roll-up for a settled parallel one; absent while running. */
  outcomeSummary?: string
  status: SubagentRowStatus
  counts: Record<SubagentRowStatus, number>
  /** "2 of 3 done" while running, "3 done, 1 failed" once settled. */
  rollupText: string
  startedAt?: number
  durationMs?: number
  duration?: string
  /** More than one agent. */
  isParallel: boolean
  /** Exactly one agent: the single-agent layout. */
  isSingleAgent: boolean
  dependencies: StageDependency[]
  agents: SubAgentItem[]
}

/** Everything one surface needs to render its Stages. */
export interface ChatScenario {
  /** Repeated on every agent of one call; the first Stage's goal that has one. */
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
