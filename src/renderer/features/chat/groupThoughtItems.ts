import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { GroupedTranscriptItem, ThoughtRun } from './groupToolItems'

type ThinkingItem = ThoughtRun['items'][number]

// Groups runs of consecutive, non-empty `thinking` items into one `ThoughtRun`.
export function groupThoughtItems(items: GroupedTranscriptItem[]): GroupedTranscriptItem[] {
  const result: GroupedTranscriptItem[] = []
  let run: ThinkingItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
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
