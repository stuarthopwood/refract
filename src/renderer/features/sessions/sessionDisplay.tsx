// Small display helpers shared between `SessionRow.tsx` (the row) and `SessionDetailsCard.tsx`
// (the hover card), split out so neither file has to import the other.

import { BellRingIcon, CircleCheckIcon, CirclePauseIcon, MessageSquareTextIcon } from 'lucide-react'
import type { Repository } from '../../../shared/model'
import { AgentSpinner } from '@/components/brand/AgentSpinner'
import { compactNumber } from '@/lib/compactNumber'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/state'
import { StatusDot } from './StatusDot'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { SessionStatus } from '../../../shared/model'
import type { StatusStyle } from '../../../shared/statusStyle'

/** Issue #731: a display-only status, never stored -- `idle` plus an unseen reply (`unread`)
 * reads as **Unread response** instead of Idle. Derived in exactly one place (`displayStatus`
 * below) so the icon, the word and every sort order stay in lockstep; nothing else may read
 * `session.status` and `session.unread` separately to decide what to show. */
export type SessionDisplayStatus = SessionStatus | 'unread-response'

/** The one place a Session's raw `status`/`unread` pair becomes the status actually shown.
 * `#735` (collapsed group header), `#748` (Show hidden badge) and `#846` (sleeping) will all
 * read this, not the raw fields. */
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

/** Issue #559 decision 12 (reused by `manageSessionsHelpers.ts`'s `filterAndSortSessions`,
 *  spec 008 FR-025, so neither file has its own copy of this substring check): does `session`'s
 *  name OR branch contain `query`, case-insensitively? `query` is already trimmed and
 *  lower-cased by the caller (both callers share that one normalisation step); an empty `query`
 *  always matches. */
export function matchesNameOrBranch(session: Pick<SessionSummary, 'name' | 'branch'>, query: string): boolean {
  if (!query) return true
  return session.name.toLowerCase().includes(query) || session.branch.toLowerCase().includes(query)
}

/** Issue #559 decision 12: the session list's own, strictly broader search -- name OR branch
 *  (above) OR the Session's own Project name. `repositoryName` is the exact string a Project's
 *  Group header shows (`RepositoryGroup`'s `label={repository.name}`; decision 14: an archived
 *  row searches the same way, against the same name its own Archived row shows as a secondary
 *  label). `query` is already trimmed and lower-cased by the caller. */
export function matchesSessionSearch(session: Pick<SessionSummary, 'name' | 'branch'>, repositoryName: string, query: string): boolean {
  if (!query) return true
  return matchesNameOrBranch(session, query) || repositoryName.toLowerCase().includes(query)
}

/** The filtered-result announcement: "Showing X of N sessions", singular "session" when the
 *  UNFILTERED total itself is 1 (the thing actually being enumerated). Moved here from
 *  `manageSessionsHelpers.ts` (issue #559 decision 23) so the Manage sessions screen and the
 *  session list's own search never phrase the same count two different ways; both import it
 *  from here now, with no re-export left in `manageSessionsHelpers.ts`. */
export function showingCountLabel(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? 'session' : 'sessions'}`
}

export interface SearchedSessions {
  /** Matching, non-archived Sessions per Project id (every Project id is present, possibly
   *  with an empty array). Already excludes archived Sessions, so a caller never needs its own
   *  second `!session.archivedAt` filter on top of this. */
  matchingByRepository: Map<string, SessionSummary[]>
  /** Matching archived Sessions, Project-resolvable only (#527's own invariant). */
  matchingArchived: SessionSummary[]
  /** Total sessions `query` actually narrows: every non-archived, Project-resolvable Session
   *  plus every Project-resolvable archived one -- an empty `query` makes `shownCount` equal
   *  this. */
  totalCount: number
  shownCount: number
}

/** Issue #559 decision 12, gate round 1 (code-reviewer Medium): the ONE place that computes
 *  what a session-list search query matches, shared by `SessionList.tsx`'s own render path and
 *  its debounced announcement (previously two independent copies that could silently drift
 *  apart, for example once #748 Hidden Sessions exist and only one copy excludes them).
 *  `query` is raw (not yet trimmed/lower-cased) -- this does that once, internally. */
export function searchSessions(sessions: SessionSummary[], repositories: Repository[], query: string): SearchedSessions {
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  const trimmed = query.trim().toLowerCase()
  const matches = (session: SessionSummary): boolean =>
    matchesSessionSearch(session, repositoriesById.get(session.repositoryId)?.name ?? '', trimmed)
  const matchingByRepository = new Map<string, SessionSummary[]>()
  for (const repository of repositories) {
    matchingByRepository.set(
      repository.id,
      sessions.filter((session) => session.repositoryId === repository.id && !session.archivedAt && matches(session))
    )
  }
  const matchingArchived = sessions.filter((session) => session.archivedAt && repositoriesById.has(session.repositoryId) && matches(session))
  const totalCount =
    sessions.filter((session) => !session.archivedAt && repositoriesById.has(session.repositoryId)).length +
    sessions.filter((session) => session.archivedAt && repositoriesById.has(session.repositoryId)).length
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

// #567 decision 11: the row's own visible time ("now", "5m", "3h", "2d", then a short date from
// 7 days on), distinct from `formatRelativeTime`'s long "ago" form above, which other surfaces
// (`SessionDetailsCard.tsx`, `ManageSessionRow.tsx`, the Pull requests view) keep using
// unchanged. The visible text this feeds is `aria-hidden`; the long form goes in the row's own
// accessible description instead (`SessionDetailsCard.tsx`'s `descriptionText`). Gate round 1 fix
// (Low, code-reviewer): `Math.round`, matching `formatRelativeTime` above -- `Math.floor` here
// disagreed with that function's own rounding for the same instant (the visible "4m" and the
// described "5m ago" could name two different numbers for one row). `'en-GB'` (not the user's own
// locale) for the short date: decision 11's own example, "12 Oct", is day-then-month with no
// comma, which is not what every locale gives `Intl.DateTimeFormat(undefined, …)` (`en-US` reads
// "Oct 12").
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

// Gate round 1 fix (Medium, a11y-auditor): `SessionDetailsCard`'s own `aria-describedby` text
// used to embed `formatRelativeTime`'s relative form here, which the shared minute tick
// (`useMinuteTick`, `SessionRow.tsx`) recomputes every 60s for every mounted row -- Chromium
// fires a description-changed accessibility event on an edit to a FOCUSED element's own
// description, and some screen readers (NVDA) speak it, so a user sitting on a recently-active
// row heard its whole description again roughly once a minute. An absolute wall-clock time never
// changes between one render and the next, so the description stays stable while still being
// accurate; the visible, `aria-hidden` short time (`formatRelativeTimeShort` above) and the
// hover card's own visible long form (`formatRelativeTime`, not read by assistive tech per this
// file's own comment) are unaffected and keep ticking live.
//
// Gate round 2 fix (High, three independent reviewers: the departure from decisions 11/16's own
// "Last active {long time}" was shipped without being recorded on #567, AND the departure's own
// implementation was wrong): the first cut was hour:minute only, with no date at all, so a
// Session idle for days read as "Last active 14:05" -- indistinguishable from one active minutes
// ago, while the sighted short time plainly showed "3d" or "12 Oct". Now day-aware: "Today HH:MM"
// on the current calendar day, else "{day} {month} HH:MM" (matching the visible short date's own
// `en-GB` day-then-month style above), with the year appended only when it differs from today's.
// Recorded on #567 as a departure from decisions 11 and 16 (gate round 2, 2026-10-16): the
// motive (a stable, non-churning description) stands; the format is now accurate, not merely
// stable.
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

/** #735 decision 21 (and #748's own future "Show hidden" badge, which will reuse this helper): the single most
 * urgent state among a Group's listed Sessions, in precedence order -- Needs you, then
 * Terminated unexpectedly, then Unread response (#731, now landed). Working, idle and an
 * ordinary Stopped Session (no `terminatedUnexpectedly`) never count. `status` feeds the shared
 * `StateIcon` unchanged (the icon colour a plain Needs you/Stopped/Unread response row already
 * uses); `label` is the word appended to the owning Group header's accessible name and is NOT
 * always `STATUS_LABEL[status]` -- a terminated-unexpectedly Session is still `status: 'stopped'`
 * but must read "Terminated unexpectedly", never the generic "Stopped" an ordinary stopped
 * Session (no marker at all) would otherwise share the icon with. */
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

// A distinct icon per Session state, never colour alone (docs/design/product-look-and-feel.md
// "Look and feel"). Issue #731: idle is `CircleCheckIcon`, the same grey glyph the Subagent
// panel's own "finished" icon uses (`SubagentPanel.tsx`, #563) -- a check means "turn ended,
// nothing owed" in both places. Unread response is `MessageSquareTextIcon` (a speech bubble
// with a tail and three text lines) in the new `--state-unread-response` info colour, distinct
// from needs-you's amber and from the three-dot glyph foundations-motion.md reserves for
// "waiting". No surface draws its own plain filled dot for this state any more (the trailing
// dot removed from `SessionRow.tsx`) -- this icon is the only signal.
export function StateIcon({ status, style }: { status: SessionDisplayStatus; style?: StatusStyle }) {
  // Issue #482: the Status style setting, applied live; the single change point for every surface.
  // style overrides it for the Appearance preview only.
  const settingDots = useSettingsStore((s) => s.settings.statusStyle === 'dots')
  if (style ? style === 'dots' : settingDots) return <StatusDot status={status} />
  // Quality-gate remediation (A11y Medium, gate round on #731): an <svg> defaults to
  // `forced-color-adjust: preserve-parent-color`, and each glyph below sets its own `color`
  // (`text-state-*`), so under Windows forced colours every glyph kept the app's own hue
  // instead of following CanvasText -- the exact gap this rule exists to close (same
  // CanvasText precedent as `AgentSpinner`, globals.css, and `radio-group.tsx`). The shapes
  // alone (disc, check-in-ring, speech bubble, bell, pause-in-ring) still carry the distinction.
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
  }
}

/** Issue #925: the coloured "+A -D" portion of a diff stat -- shared by the status line's
 * `ChangesChip`, the Session details card's diff line, the Pull requests Changes tab's own
 * aggregate line and per-file diff header (`DiffViewFromPatch`, issue #919), and the chat
 * transcript's own `DiffView` header, so none of them can colour (or leave uncoloured) the same
 * figure a different way. `added`/`removed` each take `text-diff-added`/`text-diff-removed`
 * (`globals.css`, aliasing the same `--state-working`/`--destructive` hues `DiffView.tsx`'s own
 * insert/delete tint already uses) only when strictly positive; a zero count stays
 * `text-muted-foreground` in either direction, so a `-0` never reads as an error. The leading
 * +/- glyph is the non-colour cue (WCAG 1.4.1) in every case. `compact` abbreviates past 1,000
 * via the shared `compactNumber` formatter (issue #437) for the two surfaces that already did so
 * (the status line and the Session details card); the Changes tab, its per-file header, and the
 * chat DiffView header never abbreviated before this issue, so they leave it off.
 *
 * Gate round 1 (L1): `accessibleLabel` pairs a real "N additions M deletions" `sr-only` phrase
 * (dropping the visible glyphs from assistive tech, `DiffStatLine`'s own established pattern)
 * for the four surfaces that render this component directly with no outer accessible wrapper of
 * their own (the Changes tab's aggregate line and per-file fallback, `DiffViewFromPatch`'s
 * header, the chat `DiffView`'s header) -- `DiffStatLine`'s own two callers leave it off
 * (default `false`), since they already pair a fuller sentence via `formatDiffStatAccessible`
 * one level up; pairing both here too would double-announce the same figure. */
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
          {/* Gate round 2 (Low, Main): matches `formatDiffStatAccessible`'s own phrasing below
           * (comma between the two clauses, `FULL_NUMBER_FORMAT` for both figures) -- this and
           * that function must never phrase the same stat two different ways for assistive
           * tech, the same rule the file's own header comment already states for the VISIBLE
           * figures. */}
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

/** `"N files changed +A -D"` (singular "file" for exactly one), each figure abbreviated past
 * 1,000 by the shared `compactNumber` formatter (issue #437, 2026-10-15 grill: one shared
 * lower-case k/m/b formatter for this, the Changes Readout and the Context usage Readout, so the
 * Session details card and the status line never show the same figure two ways), with a
 * trailing " (partial)" when the diff stat's caps stopped counting before the real total. Issue
 * #925: replaces the old plain-string `formatDiffStat` (removed) -- the status line's
 * `ChangesChip` and the Session details card's identical diff line both render through this one
 * component now, pairing the aria-hidden coloured visual text with the existing
 * `formatDiffStatAccessible` sr-only span below. */
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
