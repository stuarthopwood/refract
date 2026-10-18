// Issue #941 part 2: groups the Subagents panel's own flat `SubagentSummary[]` into one
// `PanelStageGroup` per `task()` call, mirroring `../chat/groupSubagentStages.ts`'s grouping and
// dependency-resolution algorithm but against the panel's OWN data shape -- `SubagentSummary` has
// no `messageId` (Stage membership there is keyed on `toolCallId` alone, confirmed against
// `model.ts`'s own interface: `id`, `toolCallId`, `specIndex`, `nameOrTask`, `status`,
// `durationMs`, nothing else) and no per-call `context` (the panel's own Stage header therefore
// falls back to the "no context" tier of `computeStageLabel` -- the shared prefix, else a solo
// Stage's own agent name, else a bare "Stage N", same three-tier rule `groupSubagentStages.ts`
// already applies, just never reaching the first context-derived tier here). A near-duplicate of
// `groupSubagentStages.ts`'s own `applyDependencies`, not a generic: the two source shapes
// (`SubagentItem` vs `SubagentSummary`) differ enough (separate `name`/`task` fields there,
// combined `nameOrTask` here) that forcing one generic through both would need as much
// indirection as the small, independently-readable duplicate below.
import type { SubagentSummary } from '../../../shared/model'
import { computeStageLabel, extractAgentRefs, type StageDependency } from '../chat/stageMeta'

export type { StageDependency } from '../chat/stageMeta'

export interface PanelStageGroup {
  kind: 'panel-stage-group'
  /** `stage:<toolCallId>`, this Stage's own React list key. */
  key: string
  toolCallId: string
  items: SubagentSummary[]
  /** 1-based position among this Session's own Stages, in start order (gate-fix: Session-wide,
   * not turn-scoped -- the panel's own flat `subagents` list already spans every turn, matching
   * `SubagentPanel.tsx`'s own existing "No agents running" Session-wide wording). */
  stageIndex: number
  totalStages: number
  /** Always the "no context" fallback tier (`computeStageLabel(undefined, names)`): the panel
   * has no per-call `context` to read (see header comment). */
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
      run.map((item) => item.id)
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
  applyPanelDependencies(stages)

  return stages
}

/** Resolves real `agent://<id>` references each Stage's own members' `nameOrTask` text makes to
 * an agent an EARLIER Stage actually started -- same "latest earlier occurrence wins" rule as
 * `groupSubagentStages.ts`'s own `applyDependencies`, against `id`/`toolCallId`/`specIndex`
 * instead of `name`/`toolCallId`/`specIndex` (the panel's own `SubagentSummary.id` IS the
 * agent's name, per that interface's own doc comment). */
function applyPanelDependencies(stages: PanelStageGroup[]): void {
  const occurrencesByAgentId = new Map<string, Array<{ stageIndex: number; toolCallId: string; specIndex: number }>>()
  for (const stage of stages) {
    for (const item of stage.items) {
      const occurrences = occurrencesByAgentId.get(item.id) ?? []
      occurrences.push({ stageIndex: stage.stageIndex, toolCallId: item.toolCallId, specIndex: item.specIndex })
      occurrencesByAgentId.set(item.id, occurrences)
    }
  }
  for (const stage of stages) {
    const text = stage.items.map((item) => item.nameOrTask).join('\n')
    const seenAgentIds = new Set<string>()
    const dependencies: StageDependency[] = []
    for (const agentId of extractAgentRefs(text)) {
      const occurrences = occurrencesByAgentId.get(agentId)
      if (!occurrences || seenAgentIds.has(agentId)) continue
      let latest: { stageIndex: number; toolCallId: string; specIndex: number } | undefined
      for (const occurrence of occurrences) {
        if (occurrence.stageIndex >= stage.stageIndex) continue
        if (!latest || occurrence.stageIndex > latest.stageIndex) latest = occurrence
      }
      if (!latest) continue
      seenAgentIds.add(agentId)
      dependencies.push({ agentId, stageIndex: latest.stageIndex, toolCallId: latest.toolCallId, specIndex: latest.specIndex })
    }
    stage.dependencies = dependencies
  }
}
