import * as React from 'react'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message'
import type { TranscriptItem } from '../../../shared/model'
import { initials } from '@/lib/initials'
import { Markdown } from './Markdown'

type UserItem = Extract<TranscriptItem, { kind: 'user' }>

interface UserMessageRowProps {
  item: UserItem
  userName: string | undefined
}

// Per-message timestamp above the user bubble (issue #555, decided 2026-10-16, `ui-architect-v3`
// roundtable): absolute wall-clock time in the user's locale, the same locale-aware primitive
// `TimeGapDivider` (Transcript.tsx) already relies on, rather than a new relative/"N min ago" or
// elapsed-since-session concept (no reliable session-start anchor for a reopened, multi-day
// Conversation). Renders as a plain, unboxed row (zero-box rule, docs/design/components.md
// "Cards and boxes") -- never inside `MessageHeader`/`MessageFooter`, which render inside the
// bubble's own (grandfathered) box. Hidden entirely when `at` is the sentinel `0` (a history
// entry OMP never timestamped, FR-046): hide rather than invent, the same guard
// Transcript.tsx's `TurnTotalLine` already uses for the same sentinel.
function UserMessageTime({ at }: { at: number }) {
  if (at === 0) return null
  const date = new Date(at)
  const label = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="mb-1 flex justify-end text-xs text-muted-foreground">
      <time dateTime={date.toISOString()}>{label}</time>
    </div>
  )
}

// Right-aligned bubble with a left indent, paired with a right-aligned avatar (docs/DESIGN.md
// "Self vs. other layout"): `Message align="end"` reverses the row and pushes it to the end;
// `w-fit max-w-[85%]` keeps the bubble sized to its own content and caps it well short of the
// transcript's left edge, so it never touches it regardless of message length.
// `UserMessageTime` renders as a sibling ABOVE this whole `Message`, never inside it.
export function UserMessageRow({ item, userName }: UserMessageRowProps) {
  const name = userName ?? 'You'
  return (
    <>
      <UserMessageTime at={item.at} />
      <Message align="end">
        <MessageAvatar aria-hidden className="text-xs font-medium">
          {initials(name)}
        </MessageAvatar>
        <MessageContent className="w-fit max-w-[85%] rounded-lg bg-accent/50 px-3 py-2">
          <MessageHeader className="px-0 text-muted-foreground">{name}</MessageHeader>
          <Markdown id={item.id} text={item.text} className="text-chat-foreground" />
        </MessageContent>
      </Message>
    </>
  )
}
