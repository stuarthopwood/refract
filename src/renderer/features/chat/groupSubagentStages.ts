import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { TranscriptItem } from '../../../shared/model'
import type { GroupedTranscriptItem } from './groupToolItems'
import { computeStageLabel, resolveStageDependencies, type StageDependency } from './stageMeta'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

export type { StageDependency } from './stageMeta'

export interface StageGroup {
  kind: 'stage-group'
  id: string
  items: SubagentItem[]
  stageIndex: number
  totalStages: number
  label: string | null
  context?: string
  dependencies: StageDependency[]
}

export type StageGroupedItem = Exclude<GroupedTranscriptItem, { kind: 'subagent' }> | StageGroup

export function isStageGroup(item: { kind: string }): item is StageGroup {
  return item.kind === 'stage-group'
}

export function groupSubagentStages(items: GroupedTranscriptItem[]): StageGroupedItem[] {
  const result: StageGroupedItem[] = []
  const stages: StageGroup[] = []
  let run: SubagentItem[] = []
  let runMessageId: string | null = null

  const flush = () => {
    if (run.length === 0) return
    const contexts = [...new Set(run.map((item) => item.context).filter((c): c is string => Boolean(c)))]
    const context = contexts.length > 0 ? contexts.join('\n\n') : undefined
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
  resolveStageDependencies(
    stages,
    (item: SubagentItem) => item.name,
    (stage) => [stage.context ?? '', ...stage.items.map((item) => item.task)].join('\n')
  )

  return result
}
