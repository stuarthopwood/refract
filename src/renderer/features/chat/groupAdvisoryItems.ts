import type { StageGroupedItem } from './groupSubagentStages'
import type { MidTurnProse } from './groupMidTurnProse'
import type { TranscriptItem } from '../../../shared/model'

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

export interface AdvisoryRun {
  kind: 'advisory-run'
  id: string
  items: AdvisoryItem[]
}

export type AdvisoryGroupedTranscriptItem = StageGroupedItem | AdvisoryRun | MidTurnProse

export function isAdvisoryRun(item: AdvisoryGroupedTranscriptItem): item is AdvisoryRun {
  return item.kind === 'advisory-run'
}

export const CONCERN_RUN_THRESHOLD = 5

export function groupAdvisoryItems(items: StageGroupedItem[]): (StageGroupedItem | AdvisoryRun)[] {
  const result: (StageGroupedItem | AdvisoryRun)[] = []
  let run: AdvisoryItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
    result.push({ kind: 'advisory-run', id: run[0]!.id, items: run })
    run = []
  }

  for (const item of items) {
    if (item.kind === 'advisory' && item.severity === 'concern') {
      run.push(item)
      continue
    }
    flushRun()
    result.push(item)
  }
  flushRun()
  return result
}
