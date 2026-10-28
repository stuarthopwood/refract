import { StickyNoteIcon } from 'lucide-react'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'
import type { MidTurnProse } from './groupMidTurnProse'

// Lines an expanded mid-turn body shows before Show more (#1236 decision 4).
const MID_TURN_CLAMP_LINES = 8

// First meaningful line as plain text: skips blank, code-fence and rule lines, drops leading
// heading/quote/list markers, turns `[text](url)` into `text`, and strips only paired emphasis
// markers (so `update_session_state` and `~/repo` survive).
function firstLineSummary(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => {
    const trimmed = candidate.trim()
    return trimmed !== '' && !/^(```|~~~|[-*_]{3,}$)/.test(trimmed)
  })
  return (line ?? '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`|~~)(.+?)\1/g, '$2')
    .trim()
}

// An assistant text followed by more of the turn (#1236, FR-117): a closed "Note" row so narration
// between tool calls stops reading like the final reply or like thinking. Always one `CollapsedLine`
// per kind, so the row keeps its own state across re-renders; the swap from the streaming reply to
// this row is a remount, which is why the wrapper turns live announcements off (the text was
// already announced while it streamed).
export function MidTurnProseRow({ group }: { group: MidTurnProse }) {
  const item = group.items[0]
  return (
    <div aria-live="off">
      <CollapsedLine
        icon={<StickyNoteIcon className="size-4 shrink-0 text-muted-foreground" />}
        label="Note"
        summary={firstLineSummary(item.text) || undefined}
        contentClassName={LABEL_COLUMN_CONTENT_CLASS}
        clampLines={MID_TURN_CLAMP_LINES}
      >
        <Markdown id={item.id} text={item.text} streaming={item.streaming} className="text-chat-foreground" />
      </CollapsedLine>
    </div>
  )
}
