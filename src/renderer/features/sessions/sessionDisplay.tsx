// Small display helpers shared between `SessionRow.tsx` (the row) and `SessionDetailsCard.tsx`
// (the hover card), split out so neither file has to import the other.

import { BellRingIcon, CircleCheckIcon, MessageSquareTextIcon, SquareIcon } from 'lucide-react'
import { AgentSpinner } from '@/components/brand/AgentSpinner'
import { compactNumber } from '@/lib/compactNumber'
import { cn } from '@/lib/utils'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { SessionStatus } from '../../../shared/model'

/** Issue #731: a display-only status, never stored -- `idle` plus an unseen reply (`unread`)
 * reads as **Unread response** instead of Idle. Derived in exactly one place (`displayStatus`
 * below) so the icon, the word and every sort order stay in lockstep; nothing else may read
 * `session.status` and `session.unread` separately to decide what to show. */
export type SessionDisplayStatus = SessionStatus | 'unread-response'

/** The one place a Session's raw `status`/`unread` pair becomes the status actually shown.
 * `#735` (collapsed group header), `#748` (Show hidden badge) and `#846` (sleeping) all read
 * this, not the raw fields. */
export function displayStatus(s: Pick<SessionSummary, 'status' | 'unread'>): SessionDisplayStatus {
  return s.status === 'idle' && s.unread ? 'unread-response' : s.status
}

export const STATUS_LABEL: Record<SessionDisplayStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  stopped: 'Stopped',
  'unread-response': 'Unread response'
}

// ISO timestamps sort and compare lexically, so no Date parsing is needed until formatting.
export function formatRelativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

// A distinct icon per Session state, never colour alone (docs/design/product-look-and-feel.md
// "Look and feel"). Issue #731: idle is `CircleCheckIcon`, the same grey glyph the Subagent
// panel's own "finished" icon uses (`SubagentPanel.tsx`, #563) -- a check means "turn ended,
// nothing owed" in both places. Unread response is `MessageSquareTextIcon` (a speech bubble
// with a tail and three text lines) in the new `--state-unread-response` info colour, distinct
// from needs-you's amber and from the three-dot glyph foundations-motion.md reserves for
// "waiting". No surface draws its own plain filled dot for this state any more (the trailing
// dot removed from `SessionRow.tsx`) -- this icon is the only signal.
export function StateIcon({ status }: { status: SessionDisplayStatus }) {
  const className = 'size-4 shrink-0'
  switch (status) {
    case 'working':
      return <AgentSpinner size={16} className={className} />
    case 'idle':
      return <CircleCheckIcon aria-hidden className={cn(className, 'text-state-idle')} />
    case 'needs-you':
      return <BellRingIcon aria-hidden className={cn(className, 'text-state-needs-you')} />
    case 'stopped':
      return <SquareIcon aria-hidden className={cn(className, 'text-state-stopped')} />
    case 'unread-response':
      return <MessageSquareTextIcon aria-hidden className={cn(className, 'text-state-unread-response')} />
  }
}


/** `"N files changed +A -D"` (singular "file" for exactly one), each figure abbreviated past
 * 1,000 by the shared `compactNumber` formatter (issue #437, 2026-10-15 grill: one shared
 * lower-case k/m/b formatter for this, the Changes Readout and the Context usage Readout, so the
 * Session details card and the status line never show the same figure two ways), with a
 * trailing " (partial)" when the diff stat's caps stopped counting before the real total. */
export function formatDiffStat(stat: DiffStat): string {
  const noun = stat.files === 1 ? 'file' : 'files'
  const suffix = stat.partial ? ' (partial)' : ''
  return `${compactNumber(stat.files)} ${noun} changed +${compactNumber(stat.additions)} -${compactNumber(stat.deletions)}${suffix}`
}

// Full, un-abbreviated figures for assistive technology (gate round 4, #437 LOW), shared between
// the status line's `ChangesChip` (`ReadoutChips.tsx`) and the Session details card below (gate
// round 5, Flow LOW: the card's own diff line had no `sr-only` pairing at all, unlike the status
// line's identical figure) -- one function so the two surfaces can never phrase the same stat
// two different ways.
const FULL_NUMBER_FORMAT = new Intl.NumberFormat()

export function formatDiffStatAccessible(stat: DiffStat): string {
  const noun = stat.files === 1 ? 'file' : 'files'
  const partialSuffix = stat.partial ? ' (partial)' : ''
  const filesFull = FULL_NUMBER_FORMAT.format(stat.files)
  const additionsFull = FULL_NUMBER_FORMAT.format(stat.additions)
  const deletionsFull = FULL_NUMBER_FORMAT.format(stat.deletions)
  const additionsNoun = stat.additions === 1 ? 'addition' : 'additions'
  const deletionsNoun = stat.deletions === 1 ? 'deletion' : 'deletions'
  return `${filesFull} ${noun} changed${partialSuffix}: ${additionsFull} ${additionsNoun}, ${deletionsFull} ${deletionsNoun}`
}
