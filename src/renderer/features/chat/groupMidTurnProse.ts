import type { TranscriptItem } from '../../../shared/model'
import type { AdvisoryGroupedTranscriptItem, AdvisoryRun } from './groupAdvisoryItems'
import type { StageGroupedItem } from './groupSubagentStages'

type AssistantTextItem = Extract<TranscriptItem, { kind: 'assistant-text' }>

// An assistant text that is not the turn's last reply (#1236, spec 001 FR-117): always a group of
// one, so `TranscriptRow` has one component per kind and a block's position never changes how it
// is keyed. Built from the item's own id, so the row keeps its identity while a block streams.
export interface MidTurnProse {
  kind: 'mid-turn-prose'
  id: string
  items: [AssistantTextItem]
}

export function isMidTurnProse(item: { kind: string }): item is MidTurnProse {
  return item.kind === 'mid-turn-prose'
}

// Short narration only (#1663, FR-117): a longer reply stays a normal reply even with more work after it.
const NOTE_MAX_LINES = 3
const NOTE_MAX_CHARS = 280

function isShortNarration(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length <= NOTE_MAX_CHARS && trimmed.split(/\r?\n/).length <= NOTE_MAX_LINES
}

// Kinds that make an earlier assistant text "mid-turn": more of the agent's work follows it.
// Thinking, notices, advisories and requests alone do not (Stuart 2026-10-27).
const FOLLOWER_KINDS: ReadonlySet<string> = new Set(['tool-group', 'tool', 'stage-group', 'subagent', 'assistant-text'])

// Wraps every assistant text that has a tool, subagent or another assistant text after it in the
// same turn. Runs last in `Transcript.tsx`'s grouping chain, over one turn's already-grouped rows,
// scanning from the end so it is one pass. A block still streaming is wrapped the moment such a
// follower exists, never before, so it renders as a normal reply while it is the latest item.
export function groupMidTurnProse(items: (StageGroupedItem | AdvisoryRun)[]): AdvisoryGroupedTranscriptItem[] {
  const result: AdvisoryGroupedTranscriptItem[] = new Array<AdvisoryGroupedTranscriptItem>(items.length)
  let followed = false
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    result[index] =
      item.kind === 'assistant-text' && followed && isShortNarration(item.text)
        ? { kind: 'mid-turn-prose', id: item.id, items: [item] }
        : item
    if (FOLLOWER_KINDS.has(item.kind)) followed = true
  }
  return result
}
