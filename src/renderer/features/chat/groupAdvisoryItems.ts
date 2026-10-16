import type { StageGroupedItem } from './groupSubagentStages'
import type { TranscriptItem } from '../../../shared/model'

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

export interface AdvisoryRun {
  kind: 'advisory-run'
  id: string
  items: AdvisoryItem[]
}

export type AdvisoryGroupedTranscriptItem = StageGroupedItem | AdvisoryRun

export function isAdvisoryRun(item: AdvisoryGroupedTranscriptItem): item is AdvisoryRun {
  return item.kind === 'advisory-run'
}

// A run of six or more CONSECUTIVE concern-severity advisories (issue #558, decision 10):
// unlike `groupThoughtItems`/`groupToolItems`'s own "always wrap, even a run of one" rule, a
// run here is deliberately NOT always-wrapped -- that rule exists specifically to protect a
// stable DOM identity against focus loss when a solo item unexpectedly gains neighbours
// (`groupThoughtItems.ts`'s own comment), a risk that does not apply here since nothing
// auto-focuses a concern row. A run of five or fewer is left exactly as the prior groupers
// produced it, rendering individually through the plain `AdvisoryRow`. A blocker or a nit --
// or any other item kind -- ends the current run without joining it; never crosses a turn,
// since this runs last in the chain, over one turn's own already-grouped items at a time.
const RUN_THRESHOLD = 5

export function groupAdvisoryItems(items: StageGroupedItem[]): AdvisoryGroupedTranscriptItem[] {
  const result: AdvisoryGroupedTranscriptItem[] = []
  let run: AdvisoryItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
    if (run.length > RUN_THRESHOLD) {
      result.push({ kind: 'advisory-run', id: run[0]!.id, items: run })
    } else {
      result.push(...run)
    }
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
