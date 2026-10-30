import type { SubagentSummary } from '../../../shared/model'
import { computeStageLabel, resolveStageDependencies, type StageDependency } from '../chat/stageMeta'

export type { StageDependency } from '../chat/stageMeta'

export interface PanelStageGroup {
  key: string
  items: SubagentSummary[]
  stageIndex: number
  label: string | null
  dependencies: StageDependency[]
}

/** Groups `summaries` into one `PanelStageGroup` per contiguous run of the same `toolCallId` -- mirrors `groupSubagentStages.ts`'s own "flush on key change" loop. */
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
      key: `stage:${run[0]!.toolCallId}`,
      items: run,
      stageIndex: 0,
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
  })
  resolveStageDependencies(
    stages,
    (item: SubagentSummary) => item.nameOrTask,
    (stage) => stage.items.map((item) => item.nameOrTask).join('\n')
  )

  return stages
}
