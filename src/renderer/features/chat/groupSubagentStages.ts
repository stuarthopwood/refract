import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { TranscriptItem } from '../../../shared/model'
import type { GroupedTranscriptItem } from './groupToolItems'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

export interface StageGroup {
  kind: 'stage-group'
  id: string
  items: SubagentItem[]
  /** 1-based position among this turn's own Stages, in start order. */
  stageIndex: number
  /** How many Stages this turn has in total -- a Stage group row's own header text ("Stage N")
   * never shows when this is 1 and the Stage has exactly one agent (decision 1: "a single agent
   * renders exactly like today's SubagentRow"); every other case gets a header (decision 1: "a
   * single stage is fully summarised by its own group header"). */
  totalStages: number
}

// Code-review gate fix (Medium, round 4, 2026-10-15): every `subagent`-kind item is now ALWAYS
// wrapped into a `StageGroup` by this function, even a run of one (the "always wrap" rule the
// comment below mirrors from `groupToolItems`) -- so a bare `subagent` item can never reach a
// consumer. Excluding it here (rather than just trusting convention) makes the compiler flag
// every stale bare-`subagent` call site as a type error.
export type StageGroupedItem = Exclude<GroupedTranscriptItem, { kind: 'subagent' }> | StageGroup

export function isStageGroup(item: StageGroupedItem): item is StageGroup {
  return item.kind === 'stage-group'
}

// Groups consecutive `subagent` transcript items into one `StageGroup` per Stage (issue #563
// decision 3): a Stage is the subagents started by one `task()` call, or by `task()` calls
// issued together with nothing else in the transcript between them. [INFERENCE, spec 001
// Clarifications 2026-10-15]: this build's transcript carries no explicit assistant-message or
// part-index field to key "issued together" on directly, so adjacency -- no intervening
// non-subagent item -- is the closest available proxy: a genuinely later, serial `task()` call
// is always preceded by at least one other item (the model's next turn: a `thinking`/`request`/
// `tool`/`assistant-text` row). Runs once per turn, AFTER `groupToolItems` (whose own `ToolGroup`
// items pass through untouched, since none has `kind: 'subagent'`).
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

  const flush = () => {
    if (run.length === 0) return
    const stage: StageGroup = { kind: 'stage-group', id: `stage:${run[0]!.id}`, items: run, stageIndex: 0, totalStages: 0 }
    stages.push(stage)
    result.push(stage)
    run = []
  }

  for (const item of items) {
    if (item.kind === 'subagent') {
      run.push(item)
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

  return result
}
