import { StickyNoteIcon } from 'lucide-react'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'
import type { MidTurnProse } from './groupMidTurnProse'

// Lines an expanded mid-turn body shows before Show more (#1236 decision 4).
const MID_TURN_CLAMP_LINES = 8

// First non-empty line with its leading Markdown markers (heading, list, quote, emphasis) removed.
function firstLineSummary(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? ''
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/[*_`~]+/g, '')
    .trim()
}

// An assistant text followed by more of the turn (#1236, FR-117): a closed "Note" row so narration
// between tool calls stops reading like the final reply or like thinking. Always one controlled
// `CollapsedLine`, so the row never remounts when a later item arrives.
export function MidTurnProseRow({ group }: { group: MidTurnProse }) {
  const item = group.items[0]
  return (
    <CollapsedLine
      icon={<StickyNoteIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      label="Note"
      summary={firstLineSummary(item.text)}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
      clampLines={MID_TURN_CLAMP_LINES}
    >
      <Markdown id={item.id} text={item.text} streaming={item.streaming} className="text-chat-foreground" />
    </CollapsedLine>
  )
}
