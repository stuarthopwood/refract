// The chip row's individual readouts (spec 004 FR-002 to FR-007, FR-021), each built on
// ReadoutChip.tsx's shared baseline. Reads `useReadoutStore()` (the visible Session's live
// bundle, seeded from `SessionSnapshot.readout` and kept live by `readout:update`/
// `subagents:update`); which of these render at all is filtered by
// `useSettingsStore().sessionReadout` in MessageInput.tsx, not repeated in each chip here.
import { useEffect, useState } from 'react'
import {
  ClockIcon,
  FileDiffIcon,
  GaugeIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  TriangleAlertIcon,
  UsersIcon
} from 'lucide-react'
import { useReadoutStore, useSessionsStore, useSubagentPanelStore } from '@/state'
import { formatDiffStat } from '@/features/sessions/sessionDisplay'
import { formatElapsed } from '../Transcript'
import { ReadoutChip } from './ReadoutChip'

const NUMBER_FORMAT = new Intl.NumberFormat()
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat(undefined, { notation: 'compact' })
/** FR-002: abbreviate past 1000, matching the Session details card's own figure past that size. */
const COMPACT_THRESHOLD = 1000

function compact(n: number): string {
  return Math.abs(n) >= COMPACT_THRESHOLD ? COMPACT_NUMBER_FORMAT.format(n) : NUMBER_FORMAT.format(n)
}

/** FR-002: "N files, +A -D", matching the Session details card's `formatDiffStat` exactly for a
 * real `DiffStat`, abbreviated past 1000; "Not available" for the `'not-available'` literal;
 * hidden (`null`) otherwise. */
export function ChangesChip() {
  const changes = useReadoutStore((s) => s.readout.changes)
  if (changes === null) return null
  if (changes === 'not-available') {
    return (
      <ReadoutChip icon={FileDiffIcon}>
        <span>Not available</span>
      </ReadoutChip>
    )
  }
  const label =
    changes.files >= COMPACT_THRESHOLD || Math.abs(changes.additions) >= COMPACT_THRESHOLD || Math.abs(changes.deletions) >= COMPACT_THRESHOLD
      ? `${compact(changes.files)} ${changes.files === 1 ? 'file' : 'files'} changed +${compact(changes.additions)} -${compact(changes.deletions)}${changes.partial ? ' (partial)' : ''}`
      : formatDiffStat(changes)
  return (
    <ReadoutChip icon={FileDiffIcon}>
      <span>{label}</span>
    </ReadoutChip>
  )
}

/** FR-003: "N/M tokens (P%)", hidden when `null`, "Not available" for the `'not-available'`
 * literal, a visible warning (icon + the word "high", never colour alone) once `percent >= 90`. */
export function ContextUsageChip() {
  const contextUsage = useReadoutStore((s) => s.readout.contextUsage)
  if (contextUsage === null) return null
  if (contextUsage === 'not-available') {
    return (
      <ReadoutChip icon={GaugeIcon}>
        <span>Not available</span>
      </ReadoutChip>
    )
  }
  const percent = Math.round(contextUsage.percent)
  const high = contextUsage.percent >= 90
  return (
    <ReadoutChip icon={high ? TriangleAlertIcon : GaugeIcon} accessibleName={high ? `Context usage high: ${percent}%` : undefined}>
      <span>
        {NUMBER_FORMAT.format(contextUsage.usedTokens)}/{NUMBER_FORMAT.format(contextUsage.windowTokens)} tokens ({percent}%)
        {high && <span className="font-medium text-destructive"> high</span>}
      </span>
    </ReadoutChip>
  )
}

/** FR-004: ticks the elapsed time once a second from `startedAt`, hidden when no turn runs. */
export function TurnTimeChip() {
  const startedAt = useReadoutStore((s) => s.readout.turnTime?.startedAt ?? null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    // Low remediation: a stale `now` from the *previous* turn (or mount) otherwise shows for up
    // to a full second before the first interval tick, briefly reading an elapsed time that
    // doesn't belong to this turn at all.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return null
  return (
    <ReadoutChip icon={ClockIcon}>
      <span>{formatElapsed(now - startedAt)}</span>
    </ReadoutChip>
  )
}

/** FR-005: a pure client clock, updating at the top of each minute, no `aria-live` region (the
 * routine tick is never announced) and a static accessible name read only on focus. Defaults
 * hidden (DEFAULT_SESSION_READOUT); visibility is the row's own settings gate, not this
 * component's concern. */
export function CurrentTimeChip() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    const timeout = setTimeout(() => {
      setNow(new Date())
      interval = setInterval(() => setNow(new Date()), 60_000)
    }, msToNextMinute)
    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [])
  const formatted = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(now)
  return (
    <ReadoutChip icon={ClockIcon}>
      {/* High remediation (a11y): a plain, non-interactive, role-less <span> cannot be named by
          aria-label per ARIA 1.2 -- several real screen readers (NVDA in browse mode, often
          Narrator/JAWS) read visible content instead, and this span's only content used to be
          aria-hidden, so the chip could read as nothing. Real, always-present text in a visually-
          hidden sibling span (the same sr-only-text-plus-aria-hidden-visual-duplicate pattern
          ToolRow.tsx/NoticeRow.tsx already use) is readable regardless of how a given screen
          reader treats aria-label on a generic element. */}
      <span className="sr-only">{`Current time: ${formatted}`}</span>
      <span aria-hidden>{formatted}</span>
    </ReadoutChip>
  )
}

/** FR-006, SC-007: shows "#N", activating it opens the pull request in the system browser via a
 * plain external `<a>` (Electron's existing `setWindowOpenHandler`, no new IPC); hidden when
 * `null` (no such pull request, no remote, a lookup failure, or GitHub unavailable all collapse
 * to the same hidden state here, with no error toast). */
export function PullRequestChip() {
  const pullRequest = useReadoutStore((s) => s.readout.pullRequest)
  if (pullRequest === null) return null
  return (
    <ReadoutChip icon={GitPullRequestIcon} href={pullRequest.url} accessibleName={`Open pull request #${pullRequest.number}`}>
      <span aria-hidden>#{pullRequest.number}</span>
    </ReadoutChip>
  )
}

/** FR-007, FR-017: the count of this turn's subagents that are running or finished (excluding
 * failed), hidden when the turn has started none. Activating it opens the Subagents panel
 * (T021) with an accessible name stating the running count. */
export function SubagentsChip() {
  const subagentCount = useReadoutStore((s) => s.readout.subagentCount)
  const sessionId = useSessionsStore((s) => s.visibleSessionId)
  const openPanel = useSubagentPanelStore((s) => s.openPanel)
  if (subagentCount === null) return null
  const total = subagentCount.running + subagentCount.finished
  const phrase = `${total} subagent${total === 1 ? '' : 's'} ${subagentCount.running > 0 ? 'running' : 'finished'}`
  return (
    <ReadoutChip
      icon={UsersIcon}
      onActivate={sessionId ? () => openPanel(sessionId) : undefined}
      accessibleName={`Open subagents panel (${subagentCount.running} running)`}
    >
      <span aria-hidden>{phrase}</span>
    </ReadoutChip>
  )
}

/** FR-021: "Todo N/M", hidden when the agent has no task list at all. */
export function TodoProgressChip() {
  const todoProgress = useReadoutStore((s) => s.readout.todoProgress)
  if (todoProgress === null) return null
  return (
    <ReadoutChip icon={ListTodoIcon}>
      {/* High remediation (a11y): see CurrentTimeChip's own comment above -- same bug, same
          sr-only fix. */}
      <span className="sr-only">{`Todo: ${todoProgress.done} of ${todoProgress.total} tasks done`}</span>
      <span aria-hidden>
        Todo {todoProgress.done}/{todoProgress.total}
      </span>
    </ReadoutChip>
  )
}
