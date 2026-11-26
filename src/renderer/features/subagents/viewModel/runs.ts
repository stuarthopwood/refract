import { HIDDEN_TOOL_NOTICE_PREFIX, type TranscriptItem } from '../../../../shared/model'
import type { GroupedTranscriptItem } from '../../chat/groupToolItems'

export type TranscriptSubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

/** One position in the transcript: a run of subagent items forming one Stage, or any other item untouched. */
export type RunSlot =
  | { kind: 'run'; items: TranscriptSubagentItem[] }
  | { kind: 'other'; item: Exclude<GroupedTranscriptItem, { kind: 'subagent' }> }

/**
 * Splits the transcript into Stage runs: consecutive subagent items of one assistant message. Any other item ends a run,
 * except the hidden-tool notice, which is invisible and so never splits a Stage.
 */
export function splitSubagentRuns(items: readonly GroupedTranscriptItem[]): RunSlot[] {
  const slots: RunSlot[] = []
  let run: TranscriptSubagentItem[] = []
  let runMessageId: string | null = null

  const flush = () => {
    if (run.length === 0) return
    slots.push({ kind: 'run', items: run })
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
    if (!(item.kind === 'notice' && item.id.startsWith(HIDDEN_TOOL_NOTICE_PREFIX))) flush()
    slots.push({ kind: 'other', item })
  }
  flush()
  return slots
}
