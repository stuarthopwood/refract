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

// Gate round 1 fix (Medium, three independent reviewers): a run of five or fewer used to stay
// an UNWRAPPED list of plain `AdvisoryRow`s, only becoming an `AdvisoryRunRow` once a sixth
// concern arrived -- decision 10's own "focus stability is a non-issue here" premise was wrong
// (decision 13 deliberately returns focus to a concern's own trigger, Copy or Ask-agent button),
// so that one extra concern remounted every existing row, dropping focus to `<body>` and
// collapsing anything the user had expanded. Every run -- INCLUDING a run of one -- is now
// ALWAYS wrapped into an `AdvisoryRun`, the same "always wrap" rule `groupThoughtItems.ts`/
// `groupToolItems.ts` already follow for exactly this reason: `AdvisoryRunRow` (AdvisoryRow.tsx)
// renders a run at or under this threshold with no "+ Show N more" control at all, so the
// visible result is unchanged for a short run -- only the DOM's own stable identity differs. A
// blocker or a nit -- or any other item kind -- ends the current run without joining it; never
// crosses a turn, since this runs last in the chain, over one turn's own already-grouped items.
export const CONCERN_RUN_THRESHOLD = 5

export function groupAdvisoryItems(items: StageGroupedItem[]): AdvisoryGroupedTranscriptItem[] {
  const result: AdvisoryGroupedTranscriptItem[] = []
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
