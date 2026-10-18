import * as React from 'react'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message'
import type { TranscriptItem } from '../../../shared/model'
import { initials } from '@/lib/initials'
import { Markdown } from './Markdown'
import { FileAttachmentChip } from './FileAttachmentChip'

export type UserItem = Extract<TranscriptItem, { kind: 'user' }>

interface UserMessageRowProps {
  item: UserItem
  userName: string | undefined
  /** Issue #555 amendment (Stuart, 2026-10-16): true when a `TimeGapDivider` already renders
   * directly above this turn (it shows the same date and time already) -- the per-message row
   * would just repeat it. */
  hideTime?: boolean
}

// Locale-aware "yesterday" (issue #555, amended 2026-10-16, Stuart's own call, gate round 1
// finding M1): `Intl.RelativeTimeFormat` gives the real localised word ("yesterday", "hier",
// "ayer", ...) instead of a hardcoded English string; `numeric: 'auto'` is what lets it return
// the word form at all (`numeric: 'always'` would give "1 day ago").
const RELATIVE_DAY_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

// Day-aware absolute time (issue #555, amended 2026-10-16 by Stuart after the gate round 1
// roundtable flagged M1: a message from another day showed a bare clock time with no date,
// since `TimeGapDivider` only ever renders BETWEEN two turns and never above the very first
// turn of a reopened, multi-day Conversation). Four tiers, all locale-aware (`undefined` locale
// argument, matching every other time format in this file): today -- bare time ("13:45");
// yesterday -- the localised day word (capitalised for its sentence-initial use here) plus time
// ("Yesterday 13:45"); same year -- day, short month, time ("14 Oct 13:45"); a different year --
// day, short month, year, then a comma before the time ("16 Oct 2025, 13:14"), the one tier that
// visually sets a full date apart from the terser forms above it. The day-diff compares each
// date's own local midnight (not a raw 24h-multiple of milliseconds), so a DST shift within the
// gap can never misclassify "yesterday" as "today" or vice versa.
function formatMessageTime(date: Date): string {
  const now = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfToday - startOfThatDay) / 86_400_000)
  if (dayDiff === 0) return time
  if (dayDiff === 1) {
    const word = RELATIVE_DAY_FORMAT.format(-1, 'day')
    return `${word[0]!.toLocaleUpperCase()}${word.slice(1)} ${time}`
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`
}

// Per-message timestamp above the user bubble (issue #555, decided 2026-10-16, `ui-architect-v3`
// roundtable; date rule amended 2026-10-16 by Stuart after gate round 1, see
// `formatMessageTime` above): absolute wall-clock time in the user's locale, the same
// locale-aware primitive `TimeGapDivider` (Transcript.tsx) already relies on, rather than a new
// relative/"N min ago" or elapsed-since-session concept (no reliable session-start anchor for a
// reopened, multi-day Conversation). Renders as a plain, unboxed row (zero-box rule,
// docs/design/components.md "Cards and boxes") -- never inside `MessageHeader`/`MessageFooter`,
// which render inside the bubble's own (grandfathered) box. Hidden entirely when `at` is the
// sentinel `0` (a history entry OMP never timestamped, FR-046) -- hide rather than invent, the
// same guard Transcript.tsx's `TurnTotalLine` already uses for the same sentinel -- OR when `at`
// is otherwise not a usable instant (gate round 1 finding M2: a nanosecond epoch or a corrupt/
// hand-edited session file can carry a JSON number outside the +-8.64e15ms range `Date` can
// hold; `new Date(at)` then becomes an Invalid Date, and `toISOString()` throws a `RangeError`
// mid-render, which the chat pane's `ErrorBoundary` would otherwise turn into a dead pane on
// every reopen of that Conversation). `Number.isFinite(date.getTime())` catches both the
// Invalid-Date case and any other non-finite result in one guard.
function UserMessageTime({ at, hide }: { at: number; hide: boolean | undefined }) {
  if (hide) return null
  if (at === 0) return null
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const label = formatMessageTime(date)
  return (
    <div className="mb-1 flex justify-end text-xs text-muted-foreground">
      <time dateTime={date.toISOString()}>{label}</time>
    </div>
  )
}

// Right-aligned bubble with a left indent, paired with a right-aligned avatar (docs/design/product-chat.md
// "Self vs. other layout"): `Message align="end"` reverses the row and pushes it to the end;
// `w-fit max-w-[85%]` keeps the bubble sized to its own content and caps it well short of the
// transcript's left edge, so it never touches it regardless of message length.
// `UserMessageTime` renders as a sibling ABOVE this whole `Message`, never inside it.
export function UserMessageRow({ item, userName, hideTime }: UserMessageRowProps) {
  const name = userName ?? 'You'
  return (
    <>
      <UserMessageTime at={item.at} hide={hideTime} />
      <Message align="end">
        <MessageAvatar aria-hidden className="text-xs font-medium">
          {initials(name)}
        </MessageAvatar>
        <MessageContent className="w-fit max-w-[85%] rounded-lg bg-accent/50 px-3 py-2">
          <MessageHeader className="px-0 text-muted-foreground">{name}</MessageHeader>
          {/* #926: the attached files/folders as chips, never the raw inlined text or path
              line the actual message carries for the agent -- a 256 KB file would otherwise
              flood the transcript. Parsed server-side out of the plain message text
              (`transcript.rs`'s own `extract_file_attachments`), so this is restart-safe too. */}
          {item.fileAttachments && item.fileAttachments.length > 0 && (
            <div role="group" aria-label="Attached files" className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {item.fileAttachments.map((file) => (
                <FileAttachmentChip key={file.id} name={file.name} byteLength={file.byteLength} isDirectory={file.isDirectory} sentAs={file.sentAs} wrap className="max-w-full" />
              ))}
            </div>
          )}
          <Markdown id={item.id} text={item.text} className="text-chat-foreground" />
        </MessageContent>
      </Message>
    </>
  )
}
