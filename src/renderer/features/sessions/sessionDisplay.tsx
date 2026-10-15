// Small display helpers shared between `SessionList.tsx` (the row) and `SessionDetailsCard.tsx`
// (the hover card), split out so neither file has to import the other.

import { BellRingIcon, CircleIcon, SquareIcon } from 'lucide-react'
import { AgentSpinner } from '@/components/brand/AgentSpinner'
import { compactNumber } from '@/lib/compactNumber'
import { cn } from '@/lib/utils'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { SessionStatus } from '../../../shared/model'

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  stopped: 'Stopped'
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

/** #735 decisions 21, 92-100 (and #748's own "Show hidden" badge, decision 100): the single most
 * urgent state among a Group's listed Sessions, in precedence order -- Needs you, then
 * Terminated unexpectedly. Working, idle and an ordinary Stopped Session (no
 * `terminatedUnexpectedly`) never count. `status` feeds the shared `StateIcon` unchanged (the
 * icon colour a plain Needs you/Stopped row already uses); `label` is the word appended to the
 * owning Group header's accessible name and is NOT always `STATUS_LABEL[status]` -- a
 * terminated-unexpectedly Session is still `status: 'stopped'` but must read "Terminated
 * unexpectedly", never the generic "Stopped" an ordinary stopped Session (no marker at all)
 * would otherwise share the icon with. */
export interface GroupWaitingState {
  status: SessionStatus
  label: string
}

export function groupWaitingState(sessions: SessionSummary[]): GroupWaitingState | null {
  if (sessions.some((session) => session.status === 'needs-you')) {
    return { status: 'needs-you', label: STATUS_LABEL['needs-you'] }
  }
  if (sessions.some((session) => session.status === 'stopped' && session.terminatedUnexpectedly)) {
    return { status: 'stopped', label: 'Terminated unexpectedly' }
  }
  return null
}

// A distinct icon per Session state, never colour alone (docs/design/product-look-and-feel.md "Look and feel").
export function StateIcon({ status }: { status: SessionStatus }) {
  const className = 'size-4 shrink-0'
  switch (status) {
    case 'working':
      return <AgentSpinner size={16} className={className} />
    case 'idle':
      return <CircleIcon aria-hidden className={cn(className, 'text-state-idle')} />
    case 'needs-you':
      return <BellRingIcon aria-hidden className={cn(className, 'text-state-needs-you')} />
    case 'stopped':
      return <SquareIcon aria-hidden className={cn(className, 'text-state-stopped')} />
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
