import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { GroupedTranscriptItem, ThoughtRun } from './groupToolItems'

type ThinkingItem = ThoughtRun['items'][number]

// Groups runs of consecutive, non-empty `thinking` items into one `ThoughtRun` (issue #557;
// mirrors `groupToolItems`'s own "always wrap, even a run of one" rule, T074): a solo thought
// still becomes a one-item `ThoughtRun` so `ThoughtRunRow` always renders through the same
// component at this tree position regardless of how many thoughts the run holds -- the exact
// focus-loss risk `groupToolItems`'s own comment documents for tool calls, decision 7/15 of the
// issue's decision record. Runs on the output of `groupToolItems`, before `groupSubagentStages`
// (`Transcript.tsx`); never crosses a turn, since it only ever sees one turn's own items at a
// time. A thinking item with empty text is dropped from grouping entirely -- defensively, since
// Rust never actually sends one (`transcript.rs:1163`) -- matching `TranscriptRow`'s own
// pre-#557 `if (!item.text) return null` for a bare thinking item. A hidden bookkeeping tool's
// own failure notice (`HIDDEN_TOOL_NOTICE_PREFIX`, T086/FR-052) is placed in front of the run and
// does not end it, the same one documented exception `groupToolItems`/`groupSubagentStages`
// already carve out, so a hidden call racing a run of thoughts can never split it in two.
export function groupThoughtItems(items: GroupedTranscriptItem[]): GroupedTranscriptItem[] {
  const result: GroupedTranscriptItem[] = []
  let run: ThinkingItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
    // Always a `ThoughtRun`, even for a run of one: see this file's own top comment.
    result.push({ kind: 'thought-run', id: run[0]!.id, items: run })
    run = []
  }

  for (const item of items) {
    if (item.kind === 'thinking') {
      if (!item.text) continue
      run.push(item)
      continue
    }
    if (item.kind === 'notice' && item.id.startsWith(HIDDEN_TOOL_NOTICE_PREFIX)) {
      result.push(item)
      continue
    }
    flushRun()
    result.push(item)
  }
  flushRun()
  return result
}
