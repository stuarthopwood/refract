
import { BellRingIcon, CircleCheckIcon, CirclePauseIcon, MessageSquareTextIcon, PauseIcon } from 'lucide-react'
import type { Repository } from '../../../shared/model'
import { AgentSpinner } from '@/components/brand/AgentSpinner'
import { compactNumber } from '@/lib/compactNumber'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/state'
import { StatusDot } from './StatusDot'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { SessionStatus } from '../../../shared/model'
import type { StatusStyle } from '../../../shared/statusStyle'

/** Issue #731: a display-only status, never stored -- `idle` plus an unseen reply (`unread`) reads as **Unread response** instead of Idle. */
export type SessionDisplayStatus = SessionStatus | 'unread-response' | 'paused'

/** `#735` (collapsed group header), `#748` (Show hidden badge) and `#846` (sleeping) will all read this, not the raw fields. */
export function displayStatus(s: Pick<SessionSummary, 'status' | 'unread' | 'pause'>): SessionDisplayStatus {
  if (s.pause === 'paused') return 'paused'
  return s.status === 'idle' && s.unread ? 'unread-response' : s.status
}

/** The word for a Session's displayed status: "Pausing…" while a pause waits on a running turn. */
export function displayLabel(s: Pick<SessionSummary, 'status' | 'unread' | 'pause'>): string {
  return s.pause === 'pausing' && s.status !== 'needs-you' ? 'Pausing…' : STATUS_LABEL[displayStatus(s)]
}

/** The one definition of "needs you" for Home's section and the nav's Home count: a live (not archived or hidden) Session waiting on the user. */
export function isNeedsYouSession(s: Pick<SessionSummary, 'status' | 'archivedAt' | 'hiddenAt'>): boolean {
  return s.status === 'needs-you' && !s.archivedAt && !s.hiddenAt
}

export const STATUS_LABEL: Record<SessionDisplayStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  stopped: 'Stopped',
  'unread-response': 'Unread response',
  paused: 'Paused'
}

/** Issue #559 decision 12 (reused by `manageSessionsHelpers.ts`'s `filterAndSortSessions`, spec 008 so neither file has its own copy of this substring check): does `session`'s name OR branch contain `query`, case-insensitively? */
export function matchesNameOrBranch(session: Pick<SessionSummary, 'name' | 'branch'>, query: string): boolean {
  if (!query) return true
  return session.name.toLowerCase().includes(query) || session.branch.toLowerCase().includes(query)
}

/** Issue #559 decision 12: the session list's own, strictly broader search -- name OR branch (above) OR the Session's own Project name. */
export function matchesSessionSearch(session: Pick<SessionSummary, 'name' | 'branch'>, repositoryName: string, query: string): boolean {
  if (!query) return true
  return matchesNameOrBranch(session, query) || repositoryName.toLowerCase().includes(query)
}

/** The filtered-result announcement: "Showing X of N sessions", singular "session" when the UNFILTERED total itself is 1 (the thing actually being enumerated). */
export function showingCountLabel(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? 'session' : 'sessions'}`
}

export interface SearchedSessions {
  // Already excludes archived Sessions, so a caller never needs its own second
  // `!session.archivedAt` filter on top of this.
  matchingByRepository: Map<string, SessionSummary[]>
  // Matching archived Sessions, Project-resolvable only (#527's own invariant).
  matchingArchived: SessionSummary[]
  totalCount: number
  shownCount: number
}

/** `query` is raw (not yet trimmed/lower-cased) -- this does that once, internally. */
export function searchSessions(sessions: SessionSummary[], repositories: Repository[], query: string, showHidden = false): SearchedSessions {
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  const trimmed = query.trim().toLowerCase()
  const matches = (session: SessionSummary): boolean =>
    matchesSessionSearch(session, repositoriesById.get(session.repositoryId)?.name ?? '', trimmed)
  // Issue #748: a hidden Session is listed while Show hidden is on, and ALWAYS matches a search.
  const listed = (session: SessionSummary): boolean => !session.hiddenAt || showHidden || trimmed !== ''
  const matchingByRepository = new Map<string, SessionSummary[]>()
  for (const repository of repositories) {
    matchingByRepository.set(
      repository.id,
      sessions.filter((session) => session.repositoryId === repository.id && !session.archivedAt && listed(session) && matches(session))
    )
  }
  const matchingArchived = sessions.filter(
    (session) => session.archivedAt && repositoriesById.has(session.repositoryId) && listed(session) && matches(session)
  )
  const totalCount = sessions.filter((session) => repositoriesById.has(session.repositoryId) && listed(session)).length
  const shownCount = trimmed
    ? [...matchingByRepository.values()].reduce((sum, list) => sum + list.length, 0) + matchingArchived.length
    : totalCount
  return { matchingByRepository, matchingArchived, totalCount, shownCount }
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

// #567 decision 11: the row's own visible time ("now", "5m", "3h", "2d", then a short date from 7
// days on), distinct from `formatRelativeTime`'s long "ago" form above, which other surfaces
// (`SessionDetailsCard.tsx`, `ManageSessionRow.tsx`, the Pull requests view) keep using unchanged.
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
export function formatRelativeTimeShort(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return SHORT_DATE_FORMAT.format(new Date(iso))
}

// An absolute wall-clock time never changes between one render and the next, so the description
// stays stable while still being accurate; the visible, `aria-hidden` short time
// (`formatRelativeTimeShort` above) and the hover card's own visible long form
// (`formatRelativeTime`, not read by assistive tech per this file's own comment) are unaffected and
// keep ticking live.
const ABSOLUTE_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const ABSOLUTE_TIME_OF_DAY_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const timeOfDay = ABSOLUTE_TIME_OF_DAY_FORMAT.format(date)
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return `Today ${timeOfDay}`
  const yearSuffix = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : ''
  return `${ABSOLUTE_DATE_FORMAT.format(date)}${yearSuffix} ${timeOfDay}`
}

/** #735 decision 21 (and #748's own future "Show hidden" badge, which will reuse this helper): the single most urgent state among a Group's listed Sessions, in precedence order -- Needs you, then Terminated unexpectedly, then Unread response (#731, now landed). */
export interface GroupWaitingState {
  status: SessionDisplayStatus
  label: string
}

export function groupWaitingState(sessions: SessionSummary[]): GroupWaitingState | null {
  if (sessions.some((session) => session.status === 'needs-you')) {
    return { status: 'needs-you', label: STATUS_LABEL['needs-you'] }
  }
  if (sessions.some((session) => session.status === 'stopped' && session.terminatedUnexpectedly)) {
    return { status: 'stopped', label: 'Terminated unexpectedly' }
  }
  if (sessions.some((session) => displayStatus(session) === 'unread-response')) {
    return { status: 'unread-response', label: STATUS_LABEL['unread-response'] }
  }
  return null
}

/** Issue #748: what the Show hidden toggle's badge and name report -- how many Sessions are hidden, and how many of those would show an attention state (the same `groupWaitingState` rule the row icons use, applied per Session so the counts agree with them). */
export function hiddenSummary(sessions: SessionSummary[]): { hidden: number; attention: number; needsYou: number } {
  const hidden = sessions.filter((session) => session.hiddenAt)
  return {
    hidden: hidden.length,
    attention: hidden.filter((session) => groupWaitingState([session]) !== null).length,
    needsYou: hidden.filter((session) => session.status === 'needs-you').length
  }
}

// A distinct icon per Session state, never colour alone (docs/design/product-look-and-feel.md "Look
// and feel").
export function StateIcon({ status, style }: { status: SessionDisplayStatus; style?: StatusStyle }) {
  // Issue #482: the Status style setting, applied live; the single change point for every surface.
  // style overrides it for the Appearance preview only.
  const settingDots = useSettingsStore((s) => s.settings.statusStyle === 'dots')
  if (style ? style === 'dots' : settingDots) return <StatusDot status={status} />
  const className = 'size-4 shrink-0 forced-colors:text-[CanvasText]'
  switch (status) {
    case 'working':
      // Issue #482: tinted with the Working state colour so every state is colour-coded.
      return <AgentSpinner size={16} className={cn(className, '[--agent-spinner-core:var(--state-working)]')} />
    case 'idle':
      return <CircleCheckIcon aria-hidden className={cn(className, 'text-state-idle')} />
    case 'needs-you':
      return <BellRingIcon aria-hidden className={cn(className, 'text-state-needs-you')} />
    case 'stopped':
      return <CirclePauseIcon aria-hidden className={cn(className, 'text-state-stopped')} />
    case 'unread-response':
      return <MessageSquareTextIcon aria-hidden className={cn(className, 'text-state-unread-response')} />
    case 'paused':
      return <PauseIcon aria-hidden className={cn(className, 'text-state-paused')} />
  }
}

/** `added`/`removed` each take `text-diff-added`/`text-diff-removed` (`globals.css`, aliasing the same `--state-working`/`--destructive` hues `DiffView.tsx`'s own insert/delete tint already uses) only when strictly positive; a zero count stays `text-muted-foreground` in either direction, so a `-0` never reads as an error. */
export function DiffStatCounts({
  added,
  removed,
  compact = false,
  accessibleLabel = false
}: {
  added: number
  removed: number
  compact?: boolean
  accessibleLabel?: boolean
}) {
  const addedText = compact ? compactNumber(added) : String(added)
  const removedText = compact ? compactNumber(removed) : String(removed)
  return (
    <span className="tabular-nums whitespace-nowrap">
      {accessibleLabel && (
        <span className="sr-only">
          {FULL_NUMBER_FORMAT.format(added)} addition{added === 1 ? '' : 's'}, {FULL_NUMBER_FORMAT.format(removed)} deletion{removed === 1 ? '' : 's'}
        </span>
      )}
      <span aria-hidden={accessibleLabel} className={added > 0 ? 'text-diff-added' : 'text-muted-foreground'}>
        +{addedText}
      </span>{' '}
      <span aria-hidden={accessibleLabel} className={removed > 0 ? 'text-diff-removed' : 'text-muted-foreground'}>
        -{removedText}
      </span>
    </span>
  )
}

/** `"N files changed +A -D"` (singular "file" for exactly one), each figure abbreviated past 1,000 by the shared `compactNumber` formatter (issue #437, 2026-10-15 grill: one shared lower-case k/m/b formatter for this, the Changes Readout and the Context usage Readout, so the Session details card and the status line never show the same figure two ways), with a trailing " (partial)" when the diff stat's caps stopped counting before the real total. */
export function DiffStatLine({ stat }: { stat: DiffStat }) {
  const noun = stat.files === 1 ? 'file' : 'files'
  return (
    <>
      <span className="sr-only">{formatDiffStatAccessible(stat)}</span>
      <span aria-hidden>
        {compactNumber(stat.files)} {noun} changed <DiffStatCounts added={stat.additions} removed={stat.deletions} compact />
        {stat.partial ? ' (partial)' : ''}
      </span>
    </>
  )
}

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
