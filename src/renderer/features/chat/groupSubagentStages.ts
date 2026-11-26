import type { SubagentSummary } from '../../../shared/model'
import type { StageItem } from '../subagents/viewModel'
import { runContext } from '../subagents/viewModel/fromTranscript'
import { splitSubagentRuns, type TranscriptSubagentItem } from '../subagents/viewModel/runs'
import { selectScenarioFromTranscript } from '../subagents/viewModel/selectors'
import type { GroupedTranscriptItem } from './groupToolItems'

export type { StageDependency } from './stageMeta'

/** One Stage's place in the transcript; everything the card derives (label, counts, times, dependencies) lives on `view`. */
export interface StageGroup {
  kind: 'stage-group'
  id: string
  items: TranscriptSubagentItem[]
  stageIndex: number
  totalStages: number
  context?: string
  view: StageItem
}

export type StageGroupedItem = Exclude<GroupedTranscriptItem, { kind: 'subagent' }> | StageGroup

export function isStageGroup(item: { kind: string }): item is StageGroup {
  return item.kind === 'stage-group'
}

/** Positions Stages in the transcript; the Stage runs and their derived fields come from the shared view-model scenario. */
export function groupSubagentStages(items: GroupedTranscriptItem[], summaries: readonly SubagentSummary[]): StageGroupedItem[] {
  const slots = splitSubagentRuns(items)
  const { stages } = selectScenarioFromTranscript(items, summaries)
  const result: StageGroupedItem[] = []
  let runIndex = 0
  for (const slot of slots) {
    if (slot.kind === 'other') {
      result.push(slot.item)
      continue
    }
    const view = stages[runIndex++]!
    result.push({
      kind: 'stage-group',
      id: view.id,
      items: slot.items,
      stageIndex: view.number,
      totalStages: stages.length,
      context: runContext(slot.items),
      view
    })
  }
  return result
}
