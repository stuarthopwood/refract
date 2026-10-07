// The chip row's individual readouts (spec 004 FR-002 to FR-007, FR-021), each built on
// ReadoutChip.tsx's shared baseline. Each takes an explicit `sessionId` prop (spec 005
// convergence, tasks.md T030: generalised from a single implicit "the visible Session" to
// per-session storage, so each pane's own chip row reads its own Session's data) and reads
// `useReadoutStore()`'s entry for that id, seeded from `SessionSnapshot.readout` and kept live
// by `readout:update`/`subagents:update`; which of these render at all is filtered by
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
import { EMPTY_READOUT_ENTRY, usePullRequestsStore, useReadoutStore, useSessionsStore, useSubagentPanelStore, useViewStore } from '@/state'
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
export function ChangesChip({ sessionId }: { sessionId: string }) {
  const changes = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.changes)
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
export function ContextUsageChip({ sessionId }: { sessionId: string }) {
  const contextUsage = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.contextUsage)
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
export function TurnTimeChip({ sessionId }: { sessionId: string }) {
  const startedAt = useReadoutStore(
    (s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.turnTime?.startedAt ?? null
  )
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
export function PullRequestChip({ sessionId }: { sessionId: string }) {
  const pullRequest = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.pullRequest)
  const session = useSessionsStore((s) => s.sessions.find((candidate) => candidate.id === sessionId))
  if (pullRequest === null) return null

  // specs/003-pull-request-management convergence: this chip shipped as a plain external link
  // before that feature's own in-app view existed (spec 004 research.md decision 4, explicitly
  // "until spec 003's own view exists"). Now that it does, activating the chip opens it there
  // instead, pre-selecting this exact pull request via the pull-requests store, then falling back
  // to the external link only if the owning repository can no longer be resolved.
  if (session) {
    return (
      <ReadoutChip
        icon={GitPullRequestIcon}
        accessibleName={`Open pull request #${pullRequest.number}`}
        onActivate={() => {
          usePullRequestsStore.getState().selectPullRequest(session.repositoryId, pullRequest.number)
          useViewStore.getState().openPullRequests(session.repositoryId)
        }}
      >
        <span aria-hidden>#{pullRequest.number}</span>
      </ReadoutChip>
    )
  }
  return (
    <ReadoutChip icon={GitPullRequestIcon} href={pullRequest.url} accessibleName={`Open pull request #${pullRequest.number}`}>
      <span aria-hidden>#{pullRequest.number}</span>
    </ReadoutChip>
  )
}

/** FR-007, FR-017; amended 2026-10-07 for issue #536: shows the running count while any of this
 * turn's subagents are still running, else a quiet "N finished" total once none are (folding a
 * seeded 'exited' orphan from issue #489 into that same quiet count -- readout.ts); hidden when
 * the turn has started none. Activating it opens the Subagents panel (T021) with an accessible
 * name stating the shown count -- built from the SAME `phrase` the visible `aria-hidden` text
 * uses (gate finding 7, WCAG 2.5.3 Label in Name): an accessible name of "Open subagents panel (2
 * running)" does not CONTAIN the visible text "2 subagents running", so a voice-control user
 * saying the visible words could never target this chip; reusing `phrase` verbatim inside the
 * name makes that impossible to drift apart again. */
export function SubagentsChip({ sessionId }: { sessionId: string }) {
  const subagentCount = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.subagentCount)
  const openPanel = useSubagentPanelStore((s) => s.openPanel)
  if (subagentCount === null) return null
  const { running, finished } = subagentCount
  const phrase = running > 0 ? `${running} subagent${running === 1 ? '' : 's'} running` : `${finished} finished`
  return (
    <ReadoutChip
      icon={UsersIcon}
      // Spec 005 convergence (tasks.md T031): activating this chip opens/retargets the one
      // shared Subagents panel to THIS pane's session -- explicit activation, never a silent
      // focus-move retarget (research.md Decision 10).
      onActivate={() => openPanel(sessionId)}
      accessibleName={`Open subagents panel (${phrase})`}
      className={running === 0 ? 'text-muted-foreground' : undefined}
    >
      <span aria-hidden>{phrase}</span>
    </ReadoutChip>
  )
}

/** FR-021: "Todo N/M", hidden when the agent has no task list at all. */
export function TodoProgressChip({ sessionId }: { sessionId: string }) {
  const todoProgress = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoProgress)
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
