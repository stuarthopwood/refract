// Issue #941 part 2: groups the Subagents panel's own flat `SubagentSummary[]` into one
// `PanelStageGroup` per `task()` call, mirroring `../chat/groupSubagentStages.ts`'s grouping
// algorithm but against the panel's OWN data shape -- `SubagentSummary` has no `messageId` (Stage
// membership there is keyed on `toolCallId` alone, confirmed against `model.ts`'s own interface:
// `id`, `toolCallId`, `specIndex`, `nameOrTask`, `status`, `durationMs`, nothing else) and no
// per-call `context` (the panel's own Stage header therefore falls back to the "no context" tier
// of `computeStageLabel` -- the shared prefix, else `null`, same rule `groupSubagentStages.ts`
// already applies, just never reaching the first context-derived tier here).
//
// Gate round 1 fix (issue #941 part 2, item 1, CRITICAL): `SubagentSummary.id` is
// `${toolCallId}:${nameOrTask}` (`subagents.rs::handle_task_start`, `base_id` built from both),
// NEVER the bare agent name alone -- the previous version keyed the label/occurrence lookup on
// `item.id`, so EVERY label/dependency computation below silently used the wrong string. Both
// now use `item.nameOrTask` (the real agent name whenever OMP gave this subagent a distinct
// `name`, confirmed true for every task in this story's own fixture -- the model.ts doc comment
// this filed claimed otherwise from is itself corrected, see that file).
import type { SubagentSummary } from '../../../shared/model'
import { computeStageLabel, resolveStageDependencies, type StageDependency } from '../chat/stageMeta'

export type { StageDependency } from '../chat/stageMeta'

export interface PanelStageGroup {
  kind: 'panel-stage-group'
  /** `stage:<toolCallId>`, this Stage's own React list key. */
  key: string
  toolCallId: string
  items: SubagentSummary[]
  /** 1-based position among this Session's own Stages, in start order (Session-wide, not
   * turn-scoped -- the panel's own flat `subagents` list already spans every turn). Internal
   * ordering only for `resolveStageDependencies`'s own "latest EARLIER Stage" rule -- gate round
   * 1 fix (item 3, DECISION): never shown as "Stage N" in the UI, since the panel's own
   * toolCallId-keyed numbering disagrees with the chat's own per-turn numbering for the SAME
   * underlying Stage. */
  stageIndex: number
  totalStages: number
  /** Always the "no context" fallback tier (`computeStageLabel(undefined, names)`): the panel
   * has no per-call `context` to read (see header comment). `null` when fewer than 2 names
   * share a meaningful prefix -- the caller falls back to "N agents" (gate round 1 decision). */
  label: string | null
  dependencies: StageDependency[]
}

/** Groups `summaries` into one `PanelStageGroup` per contiguous run of the same `toolCallId` --
 * mirrors `groupSubagentStages.ts`'s own "flush on key change" loop. A single-member Stage's own
 * group is still returned (never specially elided): the caller decides solo-vs-multi rendering
 * from `items.length`, exactly like `StageGroupRow` does for `total`. */
export function groupSubagentsIntoPanelStages(summaries: SubagentSummary[]): PanelStageGroup[] {
  const stages: PanelStageGroup[] = []
  let run: SubagentSummary[] = []
  let runToolCallId: string | null = null

  const flush = () => {
    if (run.length === 0) return
    const label = computeStageLabel(
      undefined,
      run.map((item) => item.nameOrTask)
    )
    stages.push({
      kind: 'panel-stage-group',
      key: `stage:${run[0]!.toolCallId}`,
      toolCallId: run[0]!.toolCallId,
      items: run,
      stageIndex: 0,
      totalStages: 0,
      label,
      dependencies: []
    })
    run = []
    runToolCallId = null
  }

  for (const item of summaries) {
    if (run.length > 0 && item.toolCallId !== runToolCallId) flush()
    run.push(item)
    runToolCallId = item.toolCallId
  }
  flush()

  stages.forEach((stage, index) => {
    stage.stageIndex = index + 1
    stage.totalStages = stages.length
  })
  resolveStageDependencies(
    stages,
    (item: SubagentSummary) => item.nameOrTask,
    (stage) => stage.items.map((item) => item.nameOrTask).join('\n')
  )

  return stages
}
