import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { TranscriptItem } from '../../../shared/model'
import type { GroupedTranscriptItem } from './groupToolItems'
import { computeStageLabel, extractAgentRefs, type StageDependency } from './stageMeta'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

export type { StageDependency } from './stageMeta'

export interface StageGroup {
  kind: 'stage-group'
  id: string
  items: SubagentItem[]
  /** 1-based position among this turn's own Stages, in start order. */
  stageIndex: number
  /** How many Stages this turn has in total. Gate round 3 fix (architect Low): a Stage group
   * row's own "Stage N" header is decided by agent count ALONE (`items.length === 1`, gate
   * round 2 architect addendum B) with no exception for how many Stages the turn has -- this
   * field exists for the header's OWN text ("Stage N of M") and the chain's "N stages" summary,
   * never as a second condition gating whether the header renders at all. */
  totalStages: number
  /** Issue #941 grill item 3: the batch context's own first line (cleaned, truncated), else
   * the agents' shared name prefix, else `null` -- the renderer then shows a bare "Stage N". */
  label: string | null
  /** The Stage's own shared batch `context` argument (issue #941 grill item 4's "full context
   * brief" on expansion); `undefined` when no item in the run captured one (a flat call, or
   * history from before #941). */
  context?: string
  /** Real `agent://<id>` references this Stage's own context or tasks make to an agent STARTED
   * BY AN EARLIER STAGE in the same turn (issue #941 grill item 5); empty when none resolve. */
  dependencies: StageDependency[]
}

// Code-review gate fix (Medium, round 4, 2026-10-15): every `subagent`-kind item is now ALWAYS
// wrapped into a `StageGroup` by this function, even a run of one (the "always wrap" rule the
// comment below mirrors from `groupToolItems`) -- so a bare `subagent` item can never reach a
// consumer. Excluding it here (rather than just trusting convention) makes the compiler flag
// every stale bare-`subagent` call site as a type error.
export type StageGroupedItem = Exclude<GroupedTranscriptItem, { kind: 'subagent' }> | StageGroup

// Parameter widened to `{ kind: string }` (issue #558) rather than the narrower
// `StageGroupedItem` so a caller holding a STILL-WIDER union (`groupAdvisoryItems.ts`'s own
// `AdvisoryGroupedTranscriptItem`, which also admits an `AdvisoryRun`) can call this directly
// with no cast and no import cycle; the narrowing it performs is unaffected either way.
export function isStageGroup(item: { kind: string }): item is StageGroup {
  return item.kind === 'stage-group'
}

// Groups `subagent` transcript items into one `StageGroup` per Stage (issue #563 decision 3): a
// Stage is the subagents started by one `task()` call, or by `task()` calls issued together
// within the same assistant message. Keyed on each item's own `messageId` (#563 gate round 2
// architect addendum A), stamped by the Rust transcript builder at construction time -- NOT on
// position/adjacency: reopened history carries no subagent timing to split a later serial call
// on, and an adjacency proxy could merge two genuinely serial `task()` calls that happen to land
// with nothing else between them in the transcript. A run also flushes on any non-subagent item
// (so a later Stage's own items still render at their true position in the log), and on a
// `messageId` change within an unbroken run of subagent items. Runs once per turn, AFTER
// `groupToolItems` (whose own `ToolGroup` items pass through untouched, since none has
// `kind: 'subagent'`).
//
// Mirrors `groupToolItems`'s own "always wrap, even a run of one" rule (T074, this file's
// sibling): a Stage's own row must never switch React element type as a second agent or a
// second Stage streams in -- `StageGroupRow` (SubagentChainRow.tsx) always renders through the
// same component, deciding internally (from `totalStages`/`items.length`, both plain numbers on
// this object) whether to show a header or render identically to today's bare `SubagentRow`.
export function groupSubagentStages(items: GroupedTranscriptItem[]): StageGroupedItem[] {
  const result: StageGroupedItem[] = []
  const stages: StageGroup[] = []
  let run: SubagentItem[] = []
  let runMessageId: string | null = null

  const flush = () => {
    if (run.length === 0) return
    const context = run[0]!.context
    const label = computeStageLabel(
      context,
      run.map((item) => item.name)
    )
    const stage: StageGroup = {
      kind: 'stage-group',
      id: `stage:${run[0]!.id}`,
      items: run,
      stageIndex: 0,
      totalStages: 0,
      label,
      context,
      dependencies: []
    }
    stages.push(stage)
    result.push(stage)
    run = []
    runMessageId = null
  }

  for (const item of items) {
    if (item.kind === 'subagent') {
      if (run.length > 0 && item.messageId !== runMessageId) flush()
      run.push(item)
      runMessageId = item.messageId
      continue
    }
    // A hidden-bookkeeping-tool failure notice (T086, FR-052) is the one documented exception
    // `groupToolItems` itself never flushes a tool run for; a Stage run gets the same courtesy,
    // for the same reason (a bookkeeping call racing a batch of subagents must not split it).
    if (item.kind === 'notice' && item.id.startsWith(HIDDEN_TOOL_NOTICE_PREFIX)) {
      result.push(item)
      continue
    }
    flush()
    result.push(item)
  }
  flush()

  stages.forEach((stage, index) => {
    stage.stageIndex = index + 1
    stage.totalStages = stages.length
  })
  applyDependencies(stages)

  return result
}

/** Issue #941 grill item 5: a Stage's own "Uses:" is real, never a guess -- resolves every
 * `agent://<id>` reference this Stage's own batch context or tasks make against the agent ids
 * (OMP agent ids are name-based: `shared/model.ts`'s own `SubagentSummary.id` doc comment)
 * STARTED BY AN EARLIER Stage in the same turn, and drops any reference that matches nothing
 * or points at the Stage's own agents or a LATER Stage (not yet started, so never a real
 * dependency). Mutates `stage.dependencies` in place once every Stage's final `stageIndex` is
 * known. */
function applyDependencies(stages: StageGroup[]): void {
  const stageIndexByAgentId = new Map<string, number>()
  for (const stage of stages) {
    for (const item of stage.items) {
      if (!stageIndexByAgentId.has(item.name)) stageIndexByAgentId.set(item.name, stage.stageIndex)
    }
  }
  for (const stage of stages) {
    const text = [stage.context ?? '', ...stage.items.map((item) => item.task)].join('\n')
    const seenAgentIds = new Set<string>()
    const dependencies: StageDependency[] = []
    for (const agentId of extractAgentRefs(text)) {
      const refStageIndex = stageIndexByAgentId.get(agentId)
      if (refStageIndex === undefined || refStageIndex >= stage.stageIndex) continue
      if (seenAgentIds.has(agentId)) continue
      seenAgentIds.add(agentId)
      dependencies.push({ agentId, stageIndex: refStageIndex })
    }
    stage.dependencies = dependencies
  }
}
