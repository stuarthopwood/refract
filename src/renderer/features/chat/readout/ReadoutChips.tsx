// The status line's individual readouts (spec 004 FR-002 to FR-007, FR-021), each built on
// ReadoutChip.tsx's shared baseline. Each takes an explicit `sessionId` prop (spec 005
// convergence, tasks.md T030: generalised from a single implicit "the visible Session" to
// per-session storage, so each pane's own status line reads its own Session's data) and reads
// `useReadoutStore()`'s entry for that id, seeded from `SessionSnapshot.readout` and kept live
// by `readout:update`/`subagents:update`; which of these render at all is filtered by
// `useSettingsStore().sessionReadout` in MessageInput.tsx, not repeated in each chip here.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import {
  ClockIcon,
  EyeIcon,
  FileDiffIcon,
  GaugeIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  Loader2Icon,
  TriangleAlertIcon,
  UsersIcon
} from 'lucide-react'
import { EMPTY_QUEUE, EMPTY_READOUT_ENTRY, notify, useAdvisorStore, useDraftStore, usePullRequestsStore, useQueueStore, useReadoutStore, useSessionsStore, useViewStore } from '@/state'
import { openHostedPanel } from '@/features/right-pane/hosted-panel-actions'
import { compactNumber } from '@/lib/compactNumber'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDiffStat, formatDiffStatAccessible } from '@/features/sessions/sessionDisplay'
import { formatElapsed } from '../formatElapsed'
import { COMPOSER_DISABLED_HOVER_RESET_CLASS, COMPOSER_DISABLED_OPACITY_CLASS } from '../pickerShared'
import { READOUT_CHIP_BASE_CLASS, READOUT_CHIP_INTERACTIVE_ADDITIONS, ReadoutChip } from './ReadoutChip'

// Full, un-abbreviated figures for `ContextUsageChip`'s own `sr-only` phrase below (gate round
// 4, #437 LOW): the visible text abbreviates past 1,000 via `compactNumber` (issue #437), but a
// screen-reader user hearing "seven point five k" loses precision a sighted user reading "7.5k"
// at least sees spelled out in full on hover/zoom; the full locale-formatted figure (`7,500`) is
// unambiguous read aloud either way. `ChangesChip` below shares its own equivalent,
// `formatDiffStatAccessible` (gate round 5, DRY: extracted to `sessionDisplay.tsx` so the status
// line and the Session details card's diff line can both use it, never phrasing the same stat
// two different ways).
const FULL_NUMBER_FORMAT = new Intl.NumberFormat()

/** FR-002: "N files, +A -D" (each figure abbreviated past 1,000 by the shared `compactNumber`
 * formatter, issue #437), matching the Session details card's `formatDiffStat` exactly -- both
 * now go through the same function, so neither can show the figure a different way; "Not
 * available" for the `'not-available'` literal; hidden (`null`) otherwise. The full figures
 * reach assistive technology through a real `sr-only` span next to the `aria-hidden` abbreviated
 * visual text (gate round 4, #437 LOW), the same pairing `ContextUsageChip` below already uses. */
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
  return (
    <ReadoutChip icon={FileDiffIcon}>
      <span className="sr-only">{formatDiffStatAccessible(changes)}</span>
      <span aria-hidden>{formatDiffStat(changes)}</span>
    </ReadoutChip>
  )
}

/** FR-003: "N/M (P%)" (each figure abbreviated by the shared `compactNumber` formatter, the word
 * "tokens" dropped from the visible text, issue #437, 2026-10-15 grill), hidden when `null`,
 * "Not available" for the `'not-available'` literal, a visible warning (icon + the word "high",
 * never colour alone) once `percent >= 90`. The full wording, including the high-usage warning
 * and the full (un-abbreviated) token figures, reaches assistive technology through a real
 * `sr-only` span next to the `aria-hidden` visual text -- the same pattern
 * `CurrentTimeChip`/`TodoProgressChip` already use -- rather than this chip's own former
 * `accessibleName` prop, which `ReadoutChip`'s role-less `<span>` fallback (no
 * `onActivate`/`href` here) exposes as a bare `aria-label` that several real screen readers
 * (NVDA in browse mode, often Narrator and JAWS) ignore on a non-interactive element. */
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
  // Gate round 5 fix (Flow LOW): the rounded, DISPLAYED percent is what the warning must agree
  // with -- testing the raw value let 89.5 to 89.99 show "90%" with no warning at all, since the
  // raw value itself was still under 90 even though the rounded figure the developer reads was
  // already at the threshold.
  const percent = Math.round(contextUsage.percent)
  const high = percent >= 90
  const used = compactNumber(contextUsage.usedTokens)
  const windowSize = compactNumber(contextUsage.windowTokens)
  const usedFull = FULL_NUMBER_FORMAT.format(contextUsage.usedTokens)
  const windowFull = FULL_NUMBER_FORMAT.format(contextUsage.windowTokens)
  return (
    <ReadoutChip icon={high ? TriangleAlertIcon : GaugeIcon}>
      <span className="sr-only">{`Context usage${high ? ' high' : ''}: ${usedFull} of ${windowFull} tokens used, ${percent} percent`}</span>
      <span aria-hidden>
        {used}/{windowSize} ({percent}%)
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
export function CurrentTimeChip({ className }: { className?: string } = {}) {
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
    <ReadoutChip icon={ClockIcon} className={className}>
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
 * turn's subagents are still running, else a quiet comma-joined total of whichever of
 * `finished`/`exited`/`failed`/`cancelled` are non-zero (gate fixes 2 finding 7: these are
 * worded distinctly -- "1 finished, 1 exited" -- never folded into one misleading "finished"
 * bucket, and a turn whose only subagents failed reads "1 failed", never a muted, misleading
 * "0 finished"; issue #563 decision 15: a cancelled/aborted subagent reads "1 cancelled", never
 * folded into "failed"); hidden when the turn has started none. Activating it opens the
 * Subagents panel (T021) with an accessible name stating the shown count -- built from the SAME
 * `phrase` the visible `aria-hidden` text uses (gate finding 7 (round 1), WCAG 2.5.3 Label in
 * Name): an accessible name of "Open subagents panel (2 running)" does not CONTAIN the visible
 * text "2 subagents running", so a voice-control user saying the visible words could never
 * target this chip; reusing `phrase` verbatim inside the name makes that impossible to drift
 * apart again. */
export function SubagentsChip({ sessionId }: { sessionId: string }) {
  const subagentCount = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.subagentCount)
  // Issue #563, FR-027: records the chip itself as the opener when it is the control that
  // opened the panel this time, so closing it returns focus here instead of always falling back
  // to the generic rail/launcher fallback `hosted-panel-actions.ts`'s `closeHostedPanel` applies.
  const onActivate = (event: MouseEvent<HTMLButtonElement>) => openHostedPanel('subagents', sessionId, { opener: event.currentTarget })
  if (subagentCount === null) return null
  const { running, finished, exited, failed, cancelled } = subagentCount
  const phrase = (() => {
    if (running > 0) return `${running} subagent${running === 1 ? '' : 's'} running`
    const parts: string[] = []
    if (finished > 0) parts.push(`${finished} finished`)
    if (exited > 0) parts.push(`${exited} exited`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (cancelled > 0) parts.push(`${cancelled} cancelled`)
    return parts.join(', ')
  })()
  return (
    <ReadoutChip
      icon={UsersIcon}
      // Spec 005 convergence (tasks.md T031): activating this chip opens/retargets the one
      // shared Subagents panel to THIS pane's session -- explicit activation, never a silent
      // focus-move retarget (research.md Decision 10).
      onActivate={onActivate}
      accessibleName={`Open subagents panel (${phrase})`}
      // Gate round 5 fix (Layout/Visual Medium): `ReadoutChip`'s own base class already carries
      // `text-muted-foreground` -- the old `running === 0 ? 'text-muted-foreground' : undefined`
      // was a no-op in the finished-only case and never actually emphasised the running state,
      // which FR-007's "quiet" wording for the finished total assumes exists. Flipped so the
      // RUNNING state is the one that stands out instead.
      className={running > 0 ? 'text-foreground' : undefined}
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

// Gate round 1 fix (High, #937): `chat.send` resolving while `/advisor off` turns out to fail
// still leaves a live chip whose repeat clicks must work again -- bounded so a reply that never
// arrives (a dropped `advisor:update`) cannot leave it stuck "Turning off..." forever either.
// Gate round 2 fix (Medium): only armed for an IMMEDIATE (not `queued`) send -- a send accepted
// while a turn is already running legitimately waits past this bound (the turn itself decides
// how long), so arming it there would reset `turningOff` to false while `/advisor off` is still
// genuinely pending, letting a second click queue a duplicate.
const ADVISOR_TURN_OFF_TIMEOUT_MS = 10_000

/** Issue #937 (follow-up to #917/PR #923): a quiet Advisor readout, shown only while omp's
 * advisor subsystem is on for this Session -- hidden entirely while off (no Settings toggle,
 * per the issue's own decision); no cost, spend or token figures anywhere in it or its name.
 * `advisorOn` comes from `session::advisor` (Rust): the authoritative signal is a typed or
 * chip-sent `/advisor on|off` reply, plus a best-effort silent `/advisor status` probe at
 * Session attach/resume (see that module's own header for why the probe's own reply is not
 * trusted the same way). A plain gate component: `AdvisorChipButton` below only ever mounts
 * while `advisorOn` is true, so it genuinely unmounts (not a render-to-`null` in place) the
 * instant it turns off -- gate round 1 fix (High): the earlier single-component version kept
 * rendering `null` from the SAME instance, so React cleared its button ref during the SAME
 * commit that removed the button, before the `useLayoutEffect` cleanup keyed on `advisorOn`
 * ever ran, and the focus handoff/announcement below silently never fired. `key={sessionId}`
 * also gives every Session a fresh mount (a fresh `turningOff` state) rather than reusing one
 * stuck from a different Session's own in-flight click. */
export function AdvisorChip({ sessionId, textareaRef }: { sessionId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const advisorOn = useAdvisorStore((s) => s.bySession[sessionId] ?? false)
  if (!advisorOn) return null
  return <AdvisorChipButton key={sessionId} sessionId={sessionId} textareaRef={textareaRef} />
}

function AdvisorChipButton({ sessionId, textareaRef }: { sessionId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const [turningOff, setTurningOff] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const timeoutRef = useRef<number | undefined>(undefined)
  // Gate round 3 fix (Medium): mirrors `turningOff` for the unmount cleanup below, which runs
  // inside a closure captured once at mount (an empty-deps `useLayoutEffect`) -- reading the
  // state variable there would see its STALE, always-`false` mount-time value, never the
  // current one at the moment this instance actually unmounts.
  const turningOffRef = useRef(false)
  turningOffRef.current = turningOff

  // A REAL unmount now (see `AdvisorChip`'s own comment above): an empty dependency array is
  // correct here, matching `RequestCard.tsx`'s `ResolvedRequestSummary`/`AskCard.tsx`'s own
  // identical pattern -- the cleanup fires once, exactly when this button is actually removed
  // from the DOM, while `buttonRef.current` still points at it (verified there against React
  // 19.3's own commit order: a deleted subtree's refs are cleared no earlier than this).
  useLayoutEffect(() => {
    return () => {
      window.clearTimeout(timeoutRef.current)
      // Gate round 3 fix (Medium): announces whenever THIS chip was the one mid-toggle-off
      // (`turningOff`, "the user asked for it" by clicking/activating it) -- no longer gated on
      // focus still being on it, since the user may already have tabbed elsewhere while the
      // request was in flight and still wants the completion announced. Moving focus is a
      // DIFFERENT, narrower question (never steal it from wherever the user has since gone),
      // so that part keeps its own, separate focus-presence check below.
      if (turningOffRef.current) {
        useDraftStore.getState().announceAttachment(sessionId, 'Advisor off')
      }
      if (buttonRef.current?.contains(document.activeElement)) {
        textareaRef.current?.focus()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Gate round 3 fix (High, "keep it simple"): watches THIS session's own queue for the exact
  // moment the queued `/advisor off` text leaves it -- delivered (the normal path, settled by
  // `advisor:update` already), removed (the user's own "Remove" on the chip), or dropped by an
  // abort (Stop) -- restarting the bounded timeout fallback if `advisor:update` still hasn't
  // arrived by then, so a queued send whose OWN turn never finishes (removed, aborted) cannot
  // leave the chip busy forever with no reset in flight at all.
  const queue = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  const wasQueuedRef = useRef(false)
  useEffect(() => {
    const stillQueued = queue.followUp.includes('/advisor off') || queue.steering.includes('/advisor off')
    if (stillQueued) {
      wasQueuedRef.current = true
      return
    }
    if (!wasQueuedRef.current) return
    wasQueuedRef.current = false
    if (turningOffRef.current) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = window.setTimeout(() => setTurningOff(false), ADVISOR_TURN_OFF_TIMEOUT_MS)
    }
  }, [queue])

  function handleActivate() {
    if (turningOff) return
    setTurningOff(true)
    // Gate round 1 fix (High): bounded, so a reply that never arrives (a dropped
    // `advisor:update`, an unexpected process exit) cannot leave the chip stuck "Turning
    // off..." and unclickable forever -- it simply becomes retryable again. Gate round 2 fix
    // (Medium): cleared below instead, without ever firing, when the send turns out to have
    // been `queued` (a turn is already running) -- that case has no fixed bound of its own
    // (gate round 3 fix: restarted instead once the queue effect above sees it leave the
    // queue with no `advisor:update` having arrived yet).
    timeoutRef.current = window.setTimeout(() => setTurningOff(false), ADVISOR_TURN_OFF_TIMEOUT_MS)
    window.refract.chat
      .send(sessionId, '/advisor off')
      .then((result) => {
        // Gate round 1 fix (High): `chat.send` resolves a `Result`, it does not reject on a
        // refusal (`unknown-command`, `not-idle`, ...) -- an ordinary `{ ok: false }` refusal
        // must still reset this, or a refused send leaves the chip stuck busy with no retry.
        if (!result.ok) {
          window.clearTimeout(timeoutRef.current)
          setTurningOff(false)
          notify(result.error)
          return
        }
        // Gate round 2 fix (Medium): `queued: true` means a turn was already running and
        // `/advisor off` is now waiting its turn, genuinely past this fixed bound -- stays busy
        // until `advisor:update` actually arrives (whenever the turn settles), so a second
        // click can never queue a duplicate `/advisor off` behind the first.
        if (result.value.queued) window.clearTimeout(timeoutRef.current)
      })
      .catch((err: unknown) => {
        // Gate round 2 fix (Medium): the one path the `Result` handling above cannot cover -- a
        // genuine IPC-layer throw (the channel itself failing), not an ordinary `{ ok: false }`
        // refusal; left unhandled before, an unresolved rejection with no reset at all. Gate
        // round 3 fix (Low): routed through the same `notify` as the `ok: false` path above,
        // not a separate bare `toast.error` call.
        window.clearTimeout(timeoutRef.current)
        setTurningOff(false)
        notify({ code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) })
      })
  }

  const label = turningOff ? 'Advisor on. Turning off…' : 'Advisor on. Turn off'
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <button
          ref={buttonRef}
          data-slot="readout-chip"
          type="button"
          onClick={handleActivate}
          aria-label={label}
          aria-disabled={turningOff}
          className={cn(
            READOUT_CHIP_BASE_CLASS,
            READOUT_CHIP_INTERACTIVE_ADDITIONS,
            turningOff && COMPOSER_DISABLED_OPACITY_CLASS,
            turningOff && COMPOSER_DISABLED_HOVER_RESET_CLASS,
            // Gate round 3 fix (Medium): `COMPOSER_DISABLED_HOVER_RESET_CLASS`'s own
            // `aria-disabled:hover:text-current` resolves to the INHERITED colour (this status
            // line's own ambient text colour), not this chip's own resting `muted-foreground`
            // -- the exact bug `SessionList.tsx`'s own toolbar buttons already found and fixed
            // (its own doc comment, lines ~34-39) the same way: an explicit, chip-specific
            // override naming the real resting token, not relying on `currentColor`.
            turningOff && 'aria-disabled:hover:text-muted-foreground'
          )}
        >
          {/* Gate round 2 fix (Medium, decided): a keyboard user gets no OTHER pending cue once
              focused (`:focus-visible` already overrides the dimmed opacity, and the tooltip
              closes the moment focus leaves it on activation) -- a spinning icon is the one cue
              that still shows either way. Gate round 3 fix: the comment here used to claim this
              "matches ComposerPickers.tsx exactly" -- it does not: that trigger spins at
              `size-3` with no `motion-reduce` variant; this one is `size-3.5` (this chip's own
              icon size, #928) plus `motion-reduce:animate-none` (vestibular-motion sensitivity,
              not present on that other trigger). Same SPIN APPROACH, deliberately adapted. */}
          {turningOff ? (
            <Loader2Icon aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <EyeIcon aria-hidden className="size-3.5" />
          )}
          <span aria-hidden>Advisor</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
