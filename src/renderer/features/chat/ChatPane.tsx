// The chat pane (docs/DESIGN.md "Chat", "Layout"): header, transcript, and message box for one
// Session, plus the persistent stopped-Session banner (docs/DESIGN.md "Feedback and errors").
// Spec 005: generalised from a singleton reading `visibleSessionId` to an explicit `sessionId`/
// `paneIndex` pair, so one or two of these can render side by side (App.tsx).
import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangleIcon, LoaderCircleIcon, MessageSquareIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { cn } from '@/lib/utils'
import { focusPaneContent, focusSessionsNav } from '@/lib/focus'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import {
  notify,
  useChatScrollStore,
  useCommandsStore,
  usePendingRequestsStore,
  useQueueStore,
  useReadoutStore,
  useSessionsStore,
  useSplitStore,
  useSubagentPanelStore,
  useTranscriptStore
} from '@/state'
import type { Result, SessionSnapshot, SessionStatusEvent } from '../../../shared/ipc'
import { canResumeSession, resumeSession } from './resume'
import { applySnapshot } from './applySnapshot'
import { closeChatPane } from './closeChatPane'
import { READY_CEILING_MS, type SessionStartProgress } from '../../../shared/model'
import { describeStartProgress, describeStartProgressLabel } from '@/features/sessions/startProgressDisplay'
import { BrandWatermark } from './BrandWatermark'
import { ChatHeader } from './ChatHeader'
import { MessageInput } from './MessageInput'
import { Transcript } from './Transcript'

type StopReason = SessionStatusEvent['stopReason']

interface StopInfo {
  reason?: StopReason
  detail?: string
  terminatedUnexpectedly?: boolean
  pendingToolNames?: string[]
}

/** `SessionSummary` (the sessions-store list row) carries `status` but not `stopReason`/
 * `stopDetail` (only `SessionRuntimeView` does). This is the one place that tracks them for a
 * pane's Session: seeded from the snapshot `sessions.open`/`sessions.recover` return, kept live
 * by a direct `onSessionStatus` subscription (contracts/ipc.md: that event is the "chat header
 * chip" source). */
export function describeStopReason(reason: StopReason, detail?: string): string {
  switch (reason) {
    case 'agent-exited':
      return `The agent stopped (${detail ?? 'unknown exit code'}).`
    case 'worktree-missing':
      return `Worktree missing: ${detail ?? 'the worktree folder is gone'}`
    case 'start-failed':
      // Issue #512 requirement 2 (gate-fixes Medium finding, cycle 5): `detail` carries the
      // reason plus the stderr/omp-log tails and memory figures `OmpProcess.ts`'s
      // `buildStartFailure` appends, each on its own line after the first -- only that first
      // line belongs in a title; the rest is the banner's own "Details" disclosure
      // (`startFailureDetails`, further down), never duplicated into this short string.
      return detail?.split('\n', 1)[0] || 'The agent failed to start.'
    default:
      return 'The agent is stopped.'
  }
}

/** Gate-fixes a11y High finding (cycle 9): a focused element that the user can no longer
 * interact with -- missing, `<body>` (the UA's own fallback once nothing is explicitly
 * focused), disconnected from the document, OR disabled AND inside this pane. Every one of
 * this pane's stranded-focus checks used to test only the first three, which missed a real
 * case: a Cancel that WINS during a mode-change `restart()` from `idle` sends two separate
 * status events (`startProgress` cleared first, while `status` is still `idle`;
 * `stopped`/`start-failed` moments later once `proc.stop()` finishes) -- the first moves focus
 * onto the still-enabled textarea, which the SECOND event then disables. Chromium may not blur
 * a focused element when it becomes `disabled` (it can remain `document.activeElement`, still
 * inert, depending on the Chromium version), so a check that only looked for
 * `<body>`/disconnected saw a perfectly normal-looking, connected element and left focus stuck
 * on a control the user can no longer type into or tab away from.
 *
 * Gate-fixes a11y Medium finding (cycle 10): the `:disabled` clause must only count a disabled
 * element as stranded when it is INSIDE this pane -- `root` is each call site's own
 * `chatPaneRef.current`. Without that scope, a disabled control elsewhere in the window (a
 * dialog's Save button, or the other split pane's own RequestCard Approve/Deny button while
 * `disabled={busy}`) also counted as stranded, so this pane's banner resolving pulled focus out
 * of that other control. The cycle-9 restart sequence above still works: the disabled textarea
 * it exists to rescue focus from is always inside the pane whose own effect is running.
 *
 * One shared definition here instead of several independently-drifting copies of the same test.
 */
function isFocusStranded(active: Element | null, root: HTMLElement | null): boolean {
  return !active || active === document.body || !active.isConnected || (active instanceof HTMLElement && active.matches(':disabled') && !!root?.contains(active))
}

interface ChatPaneProps {
  sessionId: string
  /** Index into `useSplitStore`'s `paneSessionIds` (0 or 1); meaningless when a split is not
   * open, but always passed so every pane-targeting action has it ready the moment one opens. */
  paneIndex: number
  /** Spec 005 (ChatHeader.tsx): only the pane actually touching the window's top-right corner
   * reserves space for the minimise/maximise/close buttons. */
  reservesWindowControls: boolean
  /** Spec 005 (research.md Decision 6, FR-017): set only by App.tsx's narrow-window collapse,
   * never while both panes are genuinely shown side by side. */
  otherSession?: { id: string; name: string } | null
  /** Spec 012 (data-model.md "Extended ChatPaneProps"): true for exactly one rendered ChatPane
   * at a time -- the single pane shown when there is only one, or the right (second, paneIndex
   * 1) pane of a true two-pane split. App.tsx computes and passes this; ChatPane itself does not
   * infer it from useSplitStore. Mounts <BrandWatermark variant="live" /> in this pane's
   * transcript container (the normal case) or its own `!session` Empty fallback, whichever
   * branch is active. */
  showWatermark?: boolean
}

export function ChatPane({ sessionId, paneIndex, reservesWindowControls, otherSession, showWatermark }: ChatPaneProps) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  // bug report point 4: while `sessions-store.ts`'s `open()` is in flight for this Session (a
  // fresh click, or a not-started Session cold-starting its agent), show that here too -- not
  // just as the list row's spinner -- since the transcript would otherwise just read "No
  // messages yet" for the ~16s a cold start takes.
  const isOpening = useSessionsStore((s) => s.openingIds.has(sessionId))
  // Spec 005 (research.md Decision 4): a just-restored pane that has not yet been opened by a
  // real user action skips the snapshot-fetch effect below entirely.
  const isPristine = useSplitStore((s) => s.pristineIds.has(sessionId))
  const isSplit = useSplitStore((s) => s.paneSessionIds.length === 2)
  const isFocused = useSplitStore((s) => s.paneSessionIds.length < 2 || s.focusedIndex === paneIndex)
  const focusMoveSignal = useSplitStore((s) => s.focusMoveSignal)
  const focusPane = useSplitStore((s) => s.focusPane)
  const openInSplit = useSplitStore((s) => s.openInSplit)
  const [stopInfo, setStopInfo] = useState<StopInfo>({})
  // Issue #512 requirement 2: whether the start-failed banner's "Details" disclosure (the
  // stderr/omp-log/memory text behind `startFailureDetails` below) is expanded.
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Gate-fixes a11y Low finding (cycle 6): stable id linking the Details toggle button to the
  // `<pre>` it reveals (`aria-controls`), so a screen reader announces what the button controls
  // instead of just its expanded/collapsed state.
  const detailsId = useId()
  // Issue #512: live while this pane's Session is starting; cleared the instant it settles.
  // Gate-fixes Medium finding (cycle 5): used to be its own `useState`, kept in sync by three
  // separate setter call sites (the live `onSessionStatus` subscription, the session-switch
  // reset effect, and the snapshot-open effect) that each duplicated work `sessions-store.ts`'s
  // `applyStatus` already does for every Session row from the exact same event. Derived
  // directly from the store instead; `session` is already read above.
  const startProgress = session?.startProgress
  // Gate-fixes a11y High finding (cycle 3): hoisted above the announcement effect below, which
  // needs `showBanner` to gate its prompt-stage announcement. A Recover/Retry start reuses the
  // OLD stopReason (SessionAgent only clears it on success), so `showBanner` used to stay true
  // for the whole wait and the interactive start banner (Keep waiting/Cancel) never rendered --
  // yet the announcement below still told screen-reader users to use controls that weren't
  // there. A live start now takes priority over a stale failure banner (`!startProgress` first).
  const effectiveStopReason = session ? (isPristine ? session.stopReason : stopInfo.reason) : undefined
  const effectiveTerminatedUnexpectedly = session
    ? isPristine
      ? !!session.terminatedUnexpectedly
      : !!stopInfo.terminatedUnexpectedly
    : false
  // `not-started` is idle-and-asleep, not an error (data-model.md) UNLESS the Conversation tail
  // shows it died mid-turn, in which case it still needs a banner (just no Recover action yet --
  // #509 adds the Resume button for exactly this case).
  const showBanner =
    !!session &&
    !startProgress &&
    session.status === 'stopped' &&
    ((!!effectiveStopReason && effectiveStopReason !== 'not-started') || effectiveTerminatedUnexpectedly)
  const [startAnnouncement, announceStart] = useClearedAnnouncement()
  // Tracks the previous `startProgress.kind` (not just presence/absence) so the one-time
  // announcement effect below can tell "a start just began" apart from "the wait just reached
  // its prompt stage" -- two different messages, each announced exactly once. Gate-fixes Medium
  // finding (cycle 6): keyed by `sessionId` too (not reset by a separate effect) -- this effect
  // and the Session-switch effect further down both run on the switch render, in DECLARATION
  // order (this one first); reading a plain `.current` here used to compare the INCOMING
  // Session's `startProgress` against the OUTGOING Session's last kind, misannouncing "Retrying
  // start for B" when switching from Session A mid-prompt to Session B merely queued. Comparing
  // `sessionId` makes a switch always read as `previousKind: undefined` for the new Session,
  // with no separate reset needed at all.
  const prevStartProgressKindRef = useRef<{ sessionId: string; kind: SessionStartProgress['kind'] | undefined }>({
    sessionId,
    kind: undefined
  })
  // Gate-fixes a11y finding: focuses the Cancel button once Keep waiting dismisses the prompt
  // (the Keep waiting button itself unmounts, since it only renders in the 'prompt' stage).
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  // Gate-fixes a11y finding: Cancel's own IPC call resolves almost immediately, but the real
  // state change (the start-failed banner replacing this one) arrives later via the live
  // `onSessionStatus` event. Captured at click time, consumed by the `showBanner` effect below,
  // same two-step pattern `handleRecover`/`handleStartNewConversation` use for their own buttons.
  const cancelFocusPendingRef = useRef<{ focusedAtStart: Element | null; hadFocus: boolean } | null>(null)
  const [recoveringId, setRecoveringId] = useState<string | null>(null)
  const [startingNewId, setStartingNewId] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  // Quality-gate remediation (code-reviewer, round 2, High): removing `key={frontSessionId}`
  // from App.tsx's single-pane `ChatPane` (restoring reclaim-focus-on-switch, a separate fix
  // above) let this SAME instance swap `sessionId` in place instead of remounting, including in
  // the narrow-window collapse and via a notification's `ui:open-session`. An open DeleteDialog
  // reads the live `session` prop, so it would then delete whatever Session this pane swapped
  // to, not the one it was opened for. Round 3 (code-reviewer, Low): the previous fix for this
  // (`key={sessionId}` on `<DeleteDialog>`, forcing a remount on every sessionId change) opened a
  // different race -- a freshly-keyed instance could mount already-open (`open={deleteOpen}` still
  // true from the outgoing Session) for one render before a reset effect ran, firing an unwanted
  // `deleteCheck` request and stealing focus, and separately let an in-flight delete on the OLD
  // instance close a dialog the user had just reopened for the NEW Session. `deleteForId` (the
  // Session id currently being deleted, or `null`) replaces both the boolean state and the key:
  // the dialog's `open` prop is `deleteForId === sessionId`, which is naturally `false` the instant
  // `sessionId` changes away from whatever it was opened for, with no separate reset effect and no
  // remount (so no stale/duplicate instance race either).
  const [deleteForId, setDeleteForId] = useState<string | null>(null)
  const deleteBannerButtonRef = useRef<HTMLButtonElement>(null)
  // Quality-gate remediation (code-reviewer/a11y, round 3, Low, #449): `focusPaneContent`'s
  // generic banner-button query (`lib/focus.ts`) always lands on the FIRST enabled
  // `[data-pane-banner]` button, which on a `start-failed` banner is "Retry", not "Start new
  // conversation" -- so a failed Start-new used to steal focus onto the wrong control. Captured
  // so `handleStartNewConversation`'s own restore can prefer the button the user actually
  // pressed, falling back to `focusPaneContent` only when it is gone or still disabled.
  const startNewButtonRef = useRef<HTMLButtonElement>(null)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // Tracks whether focus is currently somewhere inside the chat pane (the message textarea,
  // most often), kept live via a document-wide `focusin` listener rather than read at the
  // moment `sessionId` changes: by the time a session switch re-renders this component, the
  // outgoing MessageInput (`key={sessionId}`) may already be mid-unmount, and a removed
  // element's forced blur reads as `<body>`, not the pane. Used only to decide whether a
  // remounted MessageInput should reclaim focus (see `autoFocusRef` below).
  const chatPaneRef = useRef<HTMLDivElement>(null)
  const chatHadFocusRef = useRef(false)
  useEffect(() => {
    const updateFocusFlag = () => {
      chatHadFocusRef.current = !!chatPaneRef.current?.contains(document.activeElement)
    }
    updateFocusFlag()
    document.addEventListener('focusin', updateFocusFlag)
    return () => document.removeEventListener('focusin', updateFocusFlag)
  }, [])
  const prevSessionIdRef = useRef<string | null>(null)
  const autoFocusRef = useRef(false)

  // Live updates to this pane's Session's stop reason (e.g. the agent exits while it is open).
  useEffect(
    () =>
      window.refract.onSessionStatus((event) => {
        if (event.sessionId !== sessionIdRef.current) return
        // Quality-gate fix (cycle 3, 2026-10-08): this used to replace the whole object,
        // unconditionally dropping `terminatedUnexpectedly`/`pendingToolNames` -- a snapshot-
        // derived flag (from `sessions.open`/`recover`/`startNew` above) was wiped the instant
        // ANY later live status event arrived for this Session, even one carrying no
        // information about either field (e.g. a readout-only re-emit), which also hid #585's
        // Resume button and mismatched the row's own "Terminated unexpectedly" text against
        // this pane's banner title. Same three-way rule `sessions-store.ts`'s `applyStatus`
        // already uses: an explicit value on the event wins; a still-`stopped` event with none
        // keeps whatever this pane already had; a LIVE status resets both to nothing, since a
        // working/idle Session is definitely not "terminated" and has nothing pending.
        setStopInfo((prev) => ({
          reason: event.stopReason,
          detail: event.stopDetail,
          terminatedUnexpectedly:
            event.terminatedUnexpectedly ?? (event.status === 'stopped' ? prev.terminatedUnexpectedly : false),
          pendingToolNames: event.status === 'stopped' ? prev.pendingToolNames : undefined
        }))
        // `startProgress` itself needs no handling here: it is read directly off `session`
        // above, which `sessions-store.ts`'s `applyStatus` already updates from this same event.
      }),
    []
  )

  // Issue #512: a polite, one-time announcement for each of the two moments that matter (not
  // re-announced on every per-second tick, which the elapsed-time text alone already shows
  // visibly -- same "no aria-live region for the routine tick" rule ReadoutChips.tsx's clock
  // follows for the same reason): the start beginning, and the wait reaching its 'prompt'
  // stage (gate-fixes a11y finding: Keep waiting/Cancel appearing was previously silent).
  useEffect(() => {
    const prev = prevStartProgressKindRef.current
    const previousKind = prev.sessionId === sessionId ? prev.kind : undefined
    // Gate-fixes Medium finding (cycle 5, reworked cycle 6): the retry announcement fires on an
    // explicit `previousKind` 'prompt'/'extended' -> `startProgress.kind === 'queued'`
    // transition -- a retry's first progress event is always exactly `{ kind: 'queued' }`,
    // straight from whichever stage the ceiling was reached at (SessionAgent.ts's `launch()`
    // catch block) -- never on a bare undefined -> defined check, which used to misannounce the
    // next unrelated start in this pane (e.g. a mode-change restart) once an earlier attempt had
    // reached 'prompt'/'extended' and later succeeded.
    // Gate-fixes a11y Medium finding (cycle 7): `previousKind === undefined` also fires on a
    // plain Session SWITCH into a Session already mid-start (keying by `sessionId` makes a
    // switch always read as "no previous kind" for the incoming Session) -- a genuinely FRESH
    // start's first-ever progress event is always 'waiting'/'queued'/'memory-deferred' (the
    // `prompt`/`extended` stages only exist after `READY_PROMPT_AFTER_MS` has already elapsed
    // since spawn), so seeing 'prompt'/'extended' here unambiguously means a switch onto an
    // ALREADY-waiting Session, not one that "just began". Announcing "Starting agent for X" in
    // that case silently dropped the Keep waiting/Cancel announcement the third branch below
    // exists to give, so screen-reader users switching into an already-prompting Session were
    // never told those controls were on screen.
    if (session && startProgress?.kind === 'prompt' && !showBanner && previousKind === undefined) {
      announceStart(
        `${session.name} is still starting after ${Math.round(startProgress.elapsedMs / 1000)} seconds. Keep waiting or cancel.`
      )
    } else if (session && startProgress?.kind === 'extended' && previousKind === undefined) {
      announceStart(`${session.name} is still starting. Cancel to stop waiting.`)
    } else if (session && startProgress && previousKind === undefined) {
      // Gate-fixes a11y Low finding (cycle 5): the existing `role="status"` region already says
      // "Starting the agent…"/"Retrying…"/"Starting new conversation…"/"Resuming…" for these
      // same cases (below, keyed on `isOpening`/`recovering`/`startingNew`/`resuming`); this
      // polite region used to duplicate it for the exact same moment.
      if (!isOpening && recoveringId !== sessionId && startingNewId !== sessionId && resumingId !== sessionId) {
        // Gate-fixes a11y Low finding (cycle 6, generalised cycle 8): a start that begins
        // already 'queued'/'memory-deferred' (a slot was not free, or memory was low) used to
        // announce "Starting agent for X" while the row/banner's own visible text disagreed
        // ("Waiting to start…"/"waiting for memory to free up") -- a hand-written queued/else
        // ternary here was itself a second, drifting copy of exactly the kind-to-text mapping
        // `describeStartProgressLabel` exists to be the one source of (ChatPane's own banner
        // title and SessionList's row already use it). Reused directly instead.
        announceStart(`${describeStartProgressLabel(startProgress.kind)}: ${session.name}`)
      }
    } else if (session && (previousKind === 'prompt' || previousKind === 'extended') && startProgress?.kind === 'queued') {
      announceStart(`Retrying start for ${session.name}`)
    } else if (session && !showBanner && startProgress?.kind === 'prompt' && previousKind !== 'prompt') {
      // Gate-fixes a11y High finding (cycle 3): only announce "Keep waiting or cancel" when the
      // interactive banner offering them is actually about to render (`!showBanner`) -- a
      // Recover/Retry start used to announce this while the stale failure banner still hid it.
      announceStart(
        `${session.name} is still starting after ${Math.round(startProgress.elapsedMs / 1000)} seconds. Keep waiting or cancel.`
      )
    }
    prevStartProgressKindRef.current = { sessionId, kind: startProgress?.kind }
  }, [startProgress, session, announceStart, showBanner, isOpening, recoveringId, startingNewId, resumingId, sessionId])

  // Asks for a full snapshot whenever this pane's Session changes (contracts/ipc.md: "the
  // renderer ... asks for a full snapshot via sessions.open when it switches"). Also covers the
  // initial stop reason for a Session that was already stopped before this pane saw it. Spec 005
  // (research.md Decision 4): skipped entirely while `isPristine` -- a just-restored pane renders
  // from the Session's own already-cached SessionSummary below (empty transcript, no banner,
  // `stopInfo` staying `{}`), the same look a never-opened Session already has elsewhere in the
  // app, until some real action clears `isPristine`, which re-runs this effect for real.
  useEffect(() => {
    if (isPristine) return
    setStopInfo({})
    // Gate-fixes a11y Low finding (cycle 2): a cancelFocusPendingRef left over from a Cancel
    // click in the PREVIOUS Session shown in this pane must never move focus later for an
    // unrelated banner in this new one.
    cancelFocusPendingRef.current = null
    setDetailsOpen(false)
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await useSessionsStore.getState().open(sessionId)
        if (cancelled || !snapshot) return
        applySnapshot(sessionId, snapshot)
        setStopInfo({
          reason: snapshot.runtime.stopReason,
          detail: snapshot.runtime.stopDetail,
          terminatedUnexpectedly: snapshot.runtime.terminatedUnexpectedly,
          pendingToolNames: snapshot.runtime.pendingToolNames
        })
        // `startProgress` needs no handling here either (see the onSessionStatus subscription's
        // matching comment above): the live events this `open()` call's own launch may have
        // already emitted have already reached the sessions store by the time this resolves.
        // `commands:update` only pushes on the next `available_commands_update` frame from
        // OMP (SessionAgent.ts), which may not arrive again for a Session that was already
        // running before this pane (re)mounted -- e.g. a warm switch back, or a renderer
        // reload while the agent stayed up. Without this, the slash menu's `aria-controls`
        // points at a listbox that never renders (SlashMenu.tsx renders no id when the
        // command list is empty), and typing `/` shows "No matching commands" forever.
        const commandsResult = await window.refract.chat.commands(sessionId)
        if (!cancelled && commandsResult.ok) {
          useCommandsStore.getState().setForSession(sessionId, commandsResult.value)
        }
      } catch (error) {
        // Defense in depth: a throw here (e.g. a future `sessionsStore.open` regression) must
        // not silently strand the transcript on "No messages yet" forever, the way the missing
        // `window.refract.sessions.setVisible` bridge method did (see sessions-store.ts).
        if (!cancelled) console.error('[refract] opening session snapshot failed', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, isPristine])

  // Gate-fixes a11y Low finding (cycle 6): `detailsOpen` used to reset only on a Session switch
  // -- expand Details, click Retry, and a second failure's banner mounted already expanded,
  // showing fresh log text the user never asked to see (and, combined with the `role="alert"`
  // fix above, announcing it assertively). Keyed on `stopInfo.detail` directly rather than the
  // later-computed `effectiveStopDetail` (same value whenever not pristine; this hook must sit
  // above the early return either way).
  useEffect(() => {
    setDetailsOpen(false)
  }, [stopInfo.detail])

  // FR-016: a Session that no longer exists at all (`sessions.delete`, never just archived)
  // closes its own pane -- `split-store.ts`'s own `pruneDeleted` (reacting to the next
  // `sessions.list()` refresh) is the belt to this braces, for immediate responsiveness without
  // waiting on that round trip.
  // Pitfall (#621 report): now that `closePane` can take a single, non-split pane all the way to
  // ZERO (not just no-op, as it did before #621), a merely TRANSIENT `session === undefined` --
  // the sessions list momentarily out of sync with this pane's own `sessionId` -- must never be
  // mistaken for a real deletion and close the developer's only open pane out from under them.
  // Re-checks the freshest store state one frame later (the same tick a genuine
  // `sessions.list()` refresh and this store's own `set` settle on); the effect's cleanup
  // cancels the stale check if `session` becomes defined again (a re-render) before it fires.
  useEffect(() => {
    if (session) return
    const raf = requestAnimationFrame(() => {
      const stillMissing = !useSessionsStore.getState().sessions.some((s) => s.id === sessionId)
      if (stillMissing) useSplitStore.getState().closePane(paneIndex)
    })
    return () => cancelAnimationFrame(raf)
  }, [session, sessionId, paneIndex])

  // Sibling case to applySnapshot's own reset (test-reviewer finding): archiving or deleting the
  // Session never re-triggers a sessions.open() call for it (the effect above only fires when
  // `sessionId` itself changes), so applySnapshot's own panel reset never runs -- MessageInput
  // and the chip row unmount here (the Empty state below) while `useSubagentPanelStore`'s
  // `open`/`sessionId` silently keep pointing at a Session that no longer exists. Closing the
  // panel whenever that exact Session vanishes mirrors an explicit Close click instead of
  // leaving a stale, inaccessible panel open.
  useEffect(() => {
    if (session) return
    const panelState = useSubagentPanelStore.getState()
    if (panelState.sessionId === sessionId) panelState.closePanel({ restoreFocus: false })
  }, [sessionId, session])

  function handleFocusPane(): void {
    focusPane(paneIndex)
  }

  // Quality-gate remediation (accessibility-auditor, High): the keyboard focus-move chord/button
  // (App.tsx) only ever updated `focusedIndex` -- real keyboard/DOM focus stayed wherever it was,
  // so the "Focused" badge and aria-live announcement could silently contradict where typing
  // actually went. Round 2 (accessibility-auditor, High): the plain `textarea.focus()` this first
  // shipped with silently no-op'd whenever the target pane's Session is stopped (MessageInput
  // disables the textarea then) -- `focusPaneContent` now falls back to the stopped banner's own
  // button. Round 2 (code-reviewer, Medium): keying this off every false->true `isFocused`
  // transition also fired for `targetSession`'s FR-009 branch (a plain/Ctrl click, or "Open in
  // split", on the row already shown in the unfocused pane -- that only flips `focusedIndex`,
  // deliberately WITHOUT moving DOM focus, so the user can keep working in the session list),
  // yanking keyboard focus out of the session list into this pane's textarea. Now keys off
  // `focusMoveSignal` instead, which only `focusOther` (the chord and this pane's own button,
  // App.tsx) ever increments -- never `focusPane`, never any `targetSession` branch.
  const prevMoveSignalRef = useRef(focusMoveSignal)
  useEffect(() => {
    const prevSignal = prevMoveSignalRef.current
    prevMoveSignalRef.current = focusMoveSignal
    if (!isSplit || !isFocused || prevSignal === focusMoveSignal) return
    if (chatPaneRef.current?.contains(document.activeElement)) return
    focusPaneContent(chatPaneRef.current)
  }, [isFocused, isSplit, focusMoveSignal])

  // Gate-fixes a11y finding: restores focus after Cancel (issue #512) the same way
  // `handleRecover`/`handleStartNewConversation` already do for their own buttons -- the start
  // banner (with the focused Cancel button) unmounts the instant `showBanner` flips true, so
  // without this, focus would otherwise silently fall back to <body>.
  // Gate-fixes CRITICAL finding (cycle 4): these three effects (and the ref below) used to sit
  // AFTER the `if (!session) return` early return further down -- a Rules-of-Hooks violation.
  // Every render that takes the early-return branch (the open Session vanishing: delete, or a
  // pane mounting ahead of the store) called fewer hooks than the branch that doesn't, which
  // React reports as "Rendered fewer/more hooks than expected" and can crash the renderer.
  // Moved above the early return; `showBanner`, `startProgress` and `session` are all already
  // defined above this point, and `showBanner`/`startProgress` are both already falsy/undefined
  // whenever `session` is missing, so no behaviour changes for the `!session` render.
  // Gate-fixes a11y Medium finding (cycle 5): used to consume (clear) `cancelFocusPendingRef`
  // the instant `showBanner` turned true, on ANY stop reason -- but a Cancel's `start-failed`
  // can render with the stale PRE-RECOVER `agent-exited` `stopReason` still set for one frame
  // (gate-fixes Code finding, cycle 6: reworded -- `onExit` returns early on a requested exit
  // with `!stopRequested`, so Cancel itself never emits a fresh intermediate `agent-exited`
  // event; this is simply the OLD reason a Recover-then-Cancel sequence never got to clear),
  // which also makes `showBanner` true with the OLD `cancelFocusPendingRef` record still live.
  // Consuming it on THAT render left nothing for the real `start-failed` render moments later
  // to act on, once its own (different) Retry/Recover button replaced whatever this restored
  // focus to. Only consumed once `effectiveStopReason` is actually `'start-failed'`.
  useEffect(() => {
    if (!showBanner) return
    if (effectiveStopReason !== 'start-failed') return
    const pending = cancelFocusPendingRef.current
    if (!pending) return
    cancelFocusPendingRef.current = null
    if (!pending.hadFocus) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (stranded) focusPaneContent(chatPaneRef.current)
    })
  }, [showBanner, effectiveStopReason])
  // Gate-fixes a11y Medium finding (cycle 5): the effect above only re-fires on a `showBanner`
  // transition, so the agent-exited -> start-failed two-step (both `showBanner === true`, no
  // Cancel involved at all -- just Recover-from-agent-exited reaching its own ceiling) swaps a
  // Recover button for an unrelated Retry button without ever re-running it, stranding focus on
  // <body> with nothing left to restore it. Re-keyed on `effectiveStopReason` too so it also
  // fires on that second swap. `chatHadFocusRef` (not a point-in-time capture) is read here
  // because, unlike the Cancel path above, there is no click to capture "had focus" at: this
  // covers the passive multi-step banner swap instead, so it relies on the always-live listener
  // that already tracks focus for `autoFocusRef` elsewhere in this pane.
  useEffect(() => {
    if (!showBanner) return
    if (!chatHadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (stranded) focusPaneContent(chatPaneRef.current)
    })
  }, [showBanner, effectiveStopReason])
  // Gate-fixes a11y Medium finding (cycle 2): the effect above only restores focus once
  // `showBanner` turns true (the Cancel path). Two other paths remove the interactive start
  // banner (the one with Keep waiting/Cancel, 'prompt'/'extended') while it can still hold
  // focus, without ever setting `showBanner`: the agent becoming ready, and the ceiling's
  // automatic retry. Tracks whether the interactive banner was showing the PREVIOUS render so
  // this only fires on the transition away from it; `stranded` below already covers "focus was
  // never in the banner to begin with" and "the user moved focus elsewhere on their own" -- both
  // leave `document.activeElement` un-stranded, so this never steals focus from somewhere the
  // user put it deliberately.
  const prevInteractiveBannerRef = useRef(false)
  useEffect(() => {
    const wasInteractive = prevInteractiveBannerRef.current
    // Gate-fixes a11y Medium finding (cycle 6): included 'queued'/'memory-deferred' too -- this
    // cycle's Cancel button now renders for those stages as well (not just 'prompt'/'extended'),
    // so focus landing on it there and then losing the button (the stage moving on to
    // 'waiting', or the automatic retry's 'extended' -> 'queued' -> 'waiting') used to strand
    // focus on <body> with this guard never even recognising it had been on an interactive
    // banner to begin with.
    const isInteractive =
      !showBanner &&
      (startProgress?.kind === 'prompt' ||
        startProgress?.kind === 'extended' ||
        startProgress?.kind === 'queued' ||
        startProgress?.kind === 'memory-deferred')
    prevInteractiveBannerRef.current = isInteractive
    // Gate-fixes a11y Medium finding (cycle 4): dropped the `|| showBanner` exclusion this guard
    // used to have. On the Recover/Retry path, the OLD stopReason is still set, so the instant
    // a failed start clears `startProgress` back to undefined (SessionAgent.ts's `launch()`
    // catch block, once no retry is left), `showBanner` flips true immediately (the old failure
    // reason, not a fresh one) -- the exclusion skipped this effect entirely in exactly that
    // case, stranding focus on <body> for the whole second attempt. The Cancel path below is
    // unaffected: `cancelFocusPendingRef.current` (checked next) is still set then, so this
    // still defers to the `showBanner` effect above for that case specifically.
    if (!wasInteractive || isInteractive) return
    // Gate-fixes a11y High finding (cycle 3): a pending Cancel (`handleCancelStart`'s own
    // `cancelFocusPendingRef`) must be LEFT for the `showBanner` effect above to consume once the
    // start-failed event actually arrives, not cleared here. SessionAgent sends two separate
    // status events for a cancelled start -- `startProgress` cleared first, then `stopReason:
    // 'start-failed'` moments later once `proc.stop()` finishes -- and this effect's own
    // interactive-to-none transition fires on the FIRST one. Clearing or consuming the pending
    // record here (as cycle 2 did) left focus on whatever this effect restored to instead (the
    // textarea, briefly, before it goes disabled again), and the later `showBanner` effect then
    // found nothing left to act on. Gate-fixes a11y Medium finding (cycle 8, corrected cycle 9):
    // only defers this way while `session?.status === 'stopped'`. For a Session that was already
    // `stopped` before this start began (every plain, non-restart start), status stays `stopped`
    // throughout both events, so this always defers to the `showBanner` effect, exactly as
    // before. For a mode-change `restart()` (running from `idle`), status stays `idle` through
    // EVENT 1 (`startProgress` cleared) and only becomes `stopped` at EVENT 2
    // (`stopped`/`start-failed`, once `proc.stop()` finishes) -- a winning Cancel on a restart
    // DOES reach `stopped`/`start-failed` via `doRestart` -> `launch` -> `recordStartFailure`,
    // the same as any other failed start; it is not exempt. At EVENT 1 (status still `idle`) the
    // guard does not defer, so this effect's OWN stranded-focus check below runs instead and
    // moves focus onto the still-enabled textarea; at EVENT 2 the `showBanner` effect then takes
    // over and (via `isFocusStranded` now also treating a disabled element as stranded, gate-
    // fixes a11y High finding cycle 9) rescues focus from that same textarea once it becomes
    // disabled, onto the Retry/Recover button.
    if (cancelFocusPendingRef.current && session?.status === 'stopped') return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (stranded) focusPaneContent(chatPaneRef.current)
    })
  }, [startProgress?.kind, showBanner, session?.status])
  // Gate-fixes a11y High finding (cycle 3): the one genuinely stale case the effect above used to
  // clear inline -- `cancelStart()` resolved ok but did nothing because the start had already
  // succeeded -- is still cleared, just separately and only once the Session actually leaves
  // 'stopped' (a successful start): nothing will ever land on a start-failed banner after that,
  // so any pending cancel record left over is unreachable. Gate-fixes a11y Medium finding
  // (cycle 7): used to only null the record, leaving focus wherever it already was (often
  // nowhere, since the Cancel button this record was captured for had already unmounted) --
  // Cancel losing this race to a successful `ready` left keyboard/screen-reader users stranded
  // on `<body>` for the rest of the Session. Runs the same stranded-focus rAF check the other
  // focus-restore effects above use instead of a bare clear.
  useEffect(() => {
    if (session?.status === 'stopped') return
    const pending = cancelFocusPendingRef.current
    if (!pending) return
    cancelFocusPendingRef.current = null
    if (!pending.hadFocus) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (stranded) focusPaneContent(chatPaneRef.current)
    })
  }, [session?.status])
  // Issue #603 quality-gate follow-up (HIGH, a11y-auditor): rare stranded focus when the
  // banner and row Resume race -- if the SessionList row's Resume for this SAME Session
  // completes first, this pane's own stop banner disappears without `handleResume` below ever
  // running, so nothing here rescues focus if it was on the vanishing banner.
  //
  // The first version of this fix keyed on `showBanner` alone and regressed the COMMON path:
  // `ReadyWaitController` emits 'waiting' immediately (readyWait.ts), so `startProgress' is set
  // while `status' is still 'stopped' -- `showBanner' (requires `!startProgress') flips false
  // the instant ANY start begins (Recover, Retry, Resume, Start new conversation), not just on
  // the rare cross-pane race. That version then ran, found the textarea still disabled, and
  // fell through to `focusPaneContent`'s container fallback -- which the OTHER
  // `maybeRestoreFocus' helpers below then saw as "not stranded", leaving focus stuck on the
  // pane container instead of the textarea or Retry/Recover button once the start finished.
  //
  // Fixed four ways: (a) keyed on the COMBINED stop-or-start surface (`showBanner ||
  // !!startProgress`) going true -> false -- the whole surface genuinely ended (textarea
  // enabled again), not just the stop banner swapping for a start-progress one; (b) skipped
  // entirely while THIS pane's own action is in flight (`recoveringId`/`startingNewId`/
  // `resumingId` === `sessionId`) -- those flows already run their own `maybeRestoreFocus' at
  // the right moment, so this effect exists only for the cross-pane race; (c) requires
  // `chatHadFocusRef.current' before moving anything, matching every sibling stranded-focus
  // effect in this file -- never steals focus the user deliberately put elsewhere; (d) scoped
  // per Session -- the previous-value ref resets whenever `sessionId' changes, so switching
  // panes while focus sits on `<body>' from an unrelated cause never pulls it into the newly
  // shown Session's pane.
  const prevStopOrStartSurfaceRef = useRef<{ sessionId: string; shown: boolean }>({ sessionId, shown: false })
  useEffect(() => {
    const prev = prevStopOrStartSurfaceRef.current
    const stopOrStartSurface = showBanner || !!startProgress
    const wasShown = prev.sessionId === sessionId && prev.shown
    prevStopOrStartSurfaceRef.current = { sessionId, shown: stopOrStartSurface }
    if (!wasShown || stopOrStartSurface) return
    if (recoveringId === sessionId || startingNewId === sessionId || resumingId === sessionId) return
    if (!chatHadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      // Round 2 (Low, a11y): also treats the pane container itself as restorable, unlike the
      // first version -- the only one of the four restore paths in this file that did not.
      // Example: a row Resume completed, the user Tabbed back into the (now stale) start
      // banner, landed on the container via the interactive-banner effect above (the textarea
      // was still disabled), and this effect then saw "not stranded" and left it there.
      if (stranded || active === chatPaneRef.current) focusPaneContent(chatPaneRef.current)
    })
  }, [showBanner, startProgress, sessionId, recoveringId, startingNewId, resumingId])

  if (!session) {
    // Quality-gate remediation (code-reviewer/ui-architect, Medium): same fix as App.tsx's own
    // no-pane-open empty state -- `[container-type:size]` makes this root (not the window) the
    // `20cqw` query container, and `isolate` (plus the mark's own `-z-10`, BrandWatermark.tsx)
    // keeps the absolutely-positioned mark painting behind this Empty's normal-flow content
    // instead of over it (research.md decision 8).
    return (
      <Empty className="relative isolate h-full [container-type:size]">
        {showWatermark && <BrandWatermark variant="live" />}
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyTitle>No Session selected</EmptyTitle>
          <EmptyDescription>Select a Session or create one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const recovering = recoveringId === sessionId
  const startingNew = startingNewId === sessionId
  const resuming = resumingId === sessionId
  // Spec 005 (research.md Decision 4): `stopInfo` stays `{}` for a pristine pane by design (its
  // snapshot-fetch effect is skipped) -- MessageInput's own notStarted/disabled logic needs an
  // EXPLICIT 'not-started' stopReason, not undefined, so derive it from the Session's own
  // already-known SessionSummary (main's sessions.list() already reports 'not-started' for any
  // session with no live runtime this run) while pristine, instead of the live-fetched value.
  // (`effectiveStopReason`, `effectiveTerminatedUnexpectedly` and `showBanner` itself are
  // computed earlier, above, where the announcement effect needs them too.)
  const effectiveStopDetail = isPristine ? undefined : stopInfo.detail
  // Issue #512 requirement 2: everything after `effectiveStopDetail`'s first line (the stderr/
  // omp-log warnings-and-errors tails and the memory figures `OmpProcess.ts`'s
  // `buildStartFailure` appends) -- `describeStopReason`'s 'start-failed' case above only ever
  // shows that first line as the title, so this is the ONLY place the rest is still shown, kept
  // behind the banner's own "Details" disclosure rather than always visible.
  const startFailureDetails =
    effectiveStopReason === 'start-failed' && effectiveStopDetail ? effectiveStopDetail.split('\n').slice(1).join('\n').trim() : ''
  // Issue #510 slice 2 (PLAN.md row A0): independent of `effectiveStopReason` -- this is what
  // still flags a Session reopened after a Refract crash, which only ever carries `stopReason:
  // 'not-started'` (no live `onExit` ever ran this run to set `agent-exited`). (`
  // effectiveTerminatedUnexpectedly`/`effectiveStopReason`/`showBanner` are all computed
  // earlier, above -- see that comment -- so only `effectivePendingToolNames` and
  // `showTerminatedTitle` are new here.)
  const effectivePendingToolNames = isPristine ? undefined : stopInfo.pendingToolNames
  // Quality-gate fix (a11y, Medium, 2026-10-08): `worktree-missing`/`start-failed` have their own
  // dedicated actions below (Recreate/Archive/Delete, Retry/Start new) that have nothing to do
  // with a Resume instruction, so the title must keep naming THAT real reason even when the tail
  // also happens to read as terminated unexpectedly -- otherwise the banner says "Terminated
  // unexpectedly" while offering only worktree-recovery actions, naming a problem those buttons
  // do not fix.
  const showTerminatedTitle =
    effectiveTerminatedUnexpectedly && effectiveStopReason !== 'worktree-missing' && effectiveStopReason !== 'start-failed'
  // `key={sessionId}` below remounts MessageInput on every session switch, dropping its
  // textarea's focus. Reclaim it only when the switch happened while focus was already inside
  // this pane (e.g. a notification reopening the Session the user was typing in), never on
  // first load or when focus was elsewhere (session list, a dialog).
  if (prevSessionIdRef.current !== sessionId) {
    autoFocusRef.current = prevSessionIdRef.current !== null && chatHadFocusRef.current
    prevSessionIdRef.current = sessionId
  }

  async function handleRecover() {
    const recoveringFor = sessionId
    const focusedAtStart = document.activeElement
    const hadFocus = !!chatPaneRef.current?.contains(focusedAtStart)
    setRecoveringId(recoveringFor)
    const result = await window.refract.sessions.recover(recoveringFor)
    setRecoveringId(id => (id === recoveringFor ? null : id))
    // Quality-gate remediation (code-reviewer, Medium, gate cycle 3 #449): the previous check
    // treated ANY element still inside the pane as "focus didn't leave", including a ChatHeader
    // control (close/swap) the user deliberately moved to mid-call, which this then yanked
    // back. `focusedAtStart` instead captures the exact element focused when the call began
    // (the clicked banner button); restore only when focus is still there (now disabled) or has
    // nowhere else to go (<body>/null/disconnected) -- never onto some other in-pane control
    // the user actively chose.
    const maybeRestoreFocus = () => {
      if (!hadFocus || sessionIdRef.current !== recoveringFor) return
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (!stranded && active !== focusedAtStart && active !== chatPaneRef.current) return
      focusPaneContent(chatPaneRef.current)
    }
    if (!result.ok) {
      notify(result.error)
      requestAnimationFrame(maybeRestoreFocus)
      return
    }
    applySnapshot(recoveringFor, result.value)
    if (sessionIdRef.current === recoveringFor) {
      setStopInfo({
        reason: result.value.runtime.stopReason,
        detail: result.value.runtime.stopDetail,
        terminatedUnexpectedly: result.value.runtime.terminatedUnexpectedly,
        pendingToolNames: result.value.runtime.pendingToolNames
      })
      // `startProgress` needs no handling here either (see the onSessionStatus subscription's
      // matching comment above): `sessions.recover`'s own `launch()` call already emitted any
      // live events it caused before this IPC round trip resolved.
    }
    // The banner (and its focused Recover/Retry button) unmounts once the snapshot clears the
    // stop reason, dropping focus to <body>. Waits one frame for the fresh content (textarea or
    // a still-stopped banner) to mount before reclaiming focus.
    requestAnimationFrame(maybeRestoreFocus)
  }

  // Issue #509 (PLAN.md row A2g): recovers the agent AND sends the default resume instruction as
  // a real turn (`resumeSession`, shared with the session-list row's own Resume button). Mirrors
  // `handleRecover`'s focus-restore discipline exactly; the only difference is the shared helper
  // also sends the turn, so a successful result carries the snapshot built AFTER that turn was
  // sent (or the pre-send one, if that post-send rebuild itself failed -- issue #603) for
  // `stopInfo`.
  async function handleResume() {
    // Quality-gate fix (cycle 5, 2026-10-08): the button below now uses `aria-disabled` (not
    // `disabled`, matching the session-list row's own Resume button) so it stays focusable
    // during the call -- this guard is what actually stops a second concurrent invocation now
    // that the DOM no longer does.
    if (recovering || startingNew || resuming) return
    const resumingFor = sessionId
    const focusedAtStart = document.activeElement
    const hadFocus = !!chatPaneRef.current?.contains(focusedAtStart)
    setResumingId(resumingFor)
    // Issue #603 quality-gate follow-up (Low, availability): wraps the call in try/finally --
    // an unhandled rejection from `resumeSession` (the preload bridge call itself, not an
    // `{ ok: false }` result) used to leave `resumingId` stuck at `resumingFor` forever,
    // locking this banner's Resume button for the rest of the session.
    const maybeRestoreFocus = () => {
      if (!hadFocus || sessionIdRef.current !== resumingFor) return
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (!stranded && active !== focusedAtStart && active !== chatPaneRef.current) return
      focusPaneContent(chatPaneRef.current)
    }
    try {
      const result = await resumeSession(resumingFor)
      if (!result.ok) {
        notify(result.error)
        requestAnimationFrame(maybeRestoreFocus)
        return
      }
      if (sessionIdRef.current === resumingFor) {
        setStopInfo({
          reason: result.value.runtime.stopReason,
          detail: result.value.runtime.stopDetail,
          terminatedUnexpectedly: result.value.runtime.terminatedUnexpectedly,
          // Quality-gate fix (cycle 2, 2026-10-08): dropped here, unlike handleRecover/
          // handleStartNewConversation's own identical setStopInfo calls -- the banner's
          // "Still waiting on <tools>" description line went blank specifically after a Resume
          // whose restart itself failed (still-pending tools genuinely exist on that snapshot).
          pendingToolNames: result.value.runtime.pendingToolNames
        })
      }
      requestAnimationFrame(maybeRestoreFocus)
    } catch (err) {
      // Issue #603 quality-gate follow-up (Low, a11y): the try/finally below releases the lock
      // on an unhandled rejection (the bridge call itself throwing, not an `{ ok: false }`
      // result), but previously announced nothing and left focus with nothing to rescue it.
      // Round 2 (Low, a11y): hoisted `maybeRestoreFocus` above this try so it is reachable
      // here too -- a rejection after the start began (the banner already gone) used to leave
      // focus stuck on `<body>`, since the cross-pane effect above skips this exact window
      // while `resumingId === sessionId`.
      notify({ code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) })
      requestAnimationFrame(maybeRestoreFocus)
    } finally {
      setResumingId(id => (id === resumingFor ? null : id))
    }
  }

  async function handleStartNewConversation() {
    const startingFor = sessionId
    const focusedAtStart = document.activeElement
    const hadFocus = !!chatPaneRef.current?.contains(focusedAtStart)
    setStartingNewId(startingFor)
    // Quality-gate remediation (round 2, 2026-10-07): clear BEFORE awaiting below (not after) --
    // same fix as `ConversationSwitcher.tsx`'s `handleNewConversation`/`handleOpenConversation`
    // and `MessageInput.tsx`'s typed-`/new`: main emits the reset patch synchronously before
    // replying, so clearing only after `await` risks the Transcript's landing effect already
    // reading the stale pre-switch offset. Snapshot first so a failed `startNew` can put back
    // exactly what it removed (only if nothing newer has been recorded for this Session meanwhile).
    const previousScroll = useChatScrollStore.getState().bySession[startingFor]
    useChatScrollStore.getState().clear(startingFor)
    // Quality-gate finding (code review, High): see `scroll-store.ts`'s `inFlight` doc --
    // blocks `record()` for this Session for the whole in-flight window below.
    useChatScrollStore.getState().setInFlight(startingFor, true)
    let result: Result<SessionSnapshot>
    try {
      result = await window.refract.conversations.startNew(startingFor)
    } finally {
      // Always released, even if the IPC call rejects (a handler throw rejects `invoke`):
      // otherwise `record()` would stay a no-op for this Session for the app's lifetime.
      useChatScrollStore.getState().setInFlight(startingFor, false)
    }
    setStartingNewId(id => (id === startingFor ? null : id))
    // Quality-gate remediation: same fix as handleRecover above, plus round 3 (code-reviewer,
    // Low): prefer re-focusing the "Start new conversation" button itself once it's enabled
    // again -- `focusPaneContent`'s generic banner-button query always lands on "Retry" (the
    // first enabled button in DOM order on a `start-failed` banner), not the control the user
    // actually pressed.
    const maybeRestoreFocus = () => {
      if (!hadFocus || sessionIdRef.current !== startingFor) return
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (!stranded && active !== focusedAtStart && active !== chatPaneRef.current) return
      const pressed = startNewButtonRef.current
      if (pressed && pressed.isConnected && !pressed.disabled) {
        pressed.focus()
        return
      }
      focusPaneContent(chatPaneRef.current)
    }
    if (!result.ok) {
      useChatScrollStore.getState().restoreIfAbsent(startingFor, previousScroll)
      notify(result.error)
      requestAnimationFrame(maybeRestoreFocus)
      return
    }
    // Finding 4 (gate fixes 4): clears again, right before applying the snapshot -- see
    // `ConversationSwitcher.tsx`'s matching comment in `handleNewConversation`.
    useChatScrollStore.getState().clear(startingFor)
    applySnapshot(startingFor, result.value)
    if (sessionIdRef.current === startingFor) {
      setStopInfo({
        reason: result.value.runtime.stopReason,
        detail: result.value.runtime.stopDetail,
        terminatedUnexpectedly: result.value.runtime.terminatedUnexpectedly,
        pendingToolNames: result.value.runtime.pendingToolNames
      })
      // `startProgress` needs no handling here either (see the onSessionStatus subscription's
      // matching comment above): `sessions.startNewConversation`'s own `launch()` call already
      // emitted any live events it caused before this IPC round trip resolved.
    }
    requestAnimationFrame(maybeRestoreFocus)
  }

  async function handleRecreateWorktree() {
    const result = await window.refract.sessions.recreateWorktree(sessionId)
    if (!result.ok) notify(result.error)
  }

  // Issue #512's "Keep waiting"/"Cancel" buttons: fire-and-forget IPC. Neither needs a local
  // optimistic update for the TEXT -- the live `onSessionStatus` subscription above already
  // reflects the outcome (a dismissed prompt, or the failure banner once cancelStart() fails
  // the wait) the instant main processes it -- but each needs its own focus/announcement
  // follow-up (gate-fixes a11y findings), which the live event alone cannot drive.
  async function handleKeepWaitingForStart() {
    const focusedAtStart = document.activeElement
    const startedForSessionId = sessionId
    // Gate-fixes a11y Low finding (cycle 3): `keepWaiting()` is a documented no-op outside the
    // 'prompt' stage (readyWait.ts) -- announcing "Keep waiting" when it did nothing is
    // misleading, so both the elapsed time and whether to announce at all are captured here, at
    // click time, not read again after the IPC await below.
    const wasPrompt = startProgress?.kind === 'prompt'
    const elapsedMsAtClick = wasPrompt && startProgress ? startProgress.elapsedMs : 0
    const result = await window.refract.sessions.keepWaitingForStart(sessionId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    // Gate-fixes a11y Low finding (cycle 3): the pane may have switched to a different Session
    // during the IPC await; a stale announcement/focus-move for the Session this click was for
    // must never land on whatever Session is shown now.
    if (sessionIdRef.current !== startedForSessionId) return
    if (!wasPrompt) return
    // Gate-fixes a11y Low finding (cycle 2): "up to 3 minutes" was wrong once the prompt stage
    // (60s in) had already been reached -- the ceiling counts from the wait's START, not from
    // this click, so only the time actually left is accurate.
    const minutesLeft = Math.max(1, Math.round((READY_CEILING_MS - elapsedMsAtClick) / 60_000))
    announceStart(`Keep waiting: about ${minutesLeft} more minute${minutesLeft === 1 ? '' : 's'}`)
    // The Keep waiting button itself unmounts once the stage moves to 'extended' (it only
    // renders in 'prompt'); focus moves to the remaining Cancel button instead of falling back
    // to <body> -- but only if focus is still where this click left it (gate-fixes a11y Low
    // finding, cycle 2: the user may have moved focus elsewhere during the IPC await).
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stillOnOriginal = active === focusedAtStart
      const stuck = isFocusStranded(active, chatPaneRef.current)
      if (stillOnOriginal || stuck) {
        cancelButtonRef.current?.focus()
      }
    })
  }

  async function handleCancelStart() {
    const focusedAtStart = document.activeElement
    cancelFocusPendingRef.current = {
      focusedAtStart,
      hadFocus: !!chatPaneRef.current?.contains(focusedAtStart)
    }
    const result = await window.refract.sessions.cancelStart(sessionId)
    if (!result.ok) {
      cancelFocusPendingRef.current = null
      notify(result.error)
    }
  }

  async function handleArchive() {
    const result = await window.refract.sessions.archive(sessionId)
    if (!result.ok) notify(result.error)
  }

  return (
    <div
      ref={chatPaneRef}
      role="region"
      aria-label={`${session.name} chat`}
      tabIndex={-1}
      data-session-pane={sessionId}
      onMouseDownCapture={handleFocusPane}
      onFocusCapture={handleFocusPane}
      className="relative flex h-full flex-col overflow-hidden"
    >
      {/* Spec 005 (research.md Decision 9): the focused pane's accent bar, mirroring
          SessionList.tsx's own `aria-current` left-edge bar; paired with ChatHeader's visible
          "Focused" text badge so the marker is never colour alone. */}
      {isSplit && isFocused && (
        <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-active-indicator" />
      )}
      <ChatHeader
        sessionId={sessionId}
        focused={isSplit ? isFocused : undefined}
        // Issue #621 (close chat pane): always rendered now, not gated on `isSplit` -- a single,
        // non-split pane is independently closeable down to the existing zero-session empty
        // state. `closeChatPane` (shared with App.tsx's Ctrl+W chord) owns the announcement and
        // the focus fallback chain for both the 2->1 (unchanged) and 1->0 (#621) cases.
        onClose={() => closeChatPane(paneIndex)}
        otherSessionName={otherSession?.name}
        onSwapToOther={otherSession ? () => openInSplit(otherSession.id) : undefined}
        reservesWindowControls={reservesWindowControls}
      />
      <div
        role="status"
        className={cn(
          'flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2 text-xs text-muted-foreground',
          !isOpening && !recovering && !startingNew && !resuming && 'sr-only'
        )}
      >
        {isOpening && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Starting the agent…
          </>
        )}
        {/* Quality-gate remediation (a11y, Medium, gate cycle 3 #449): the Recover/Retry/Start
            new banner button is disabled (and so loses focus) for the whole await, which left
            its "Retrying…"/"Starting…" text announced to nobody -- a disabled element is pulled
            out of the accessibility tree. Mirrors that same busy text into this already-`role=
            "status"` region instead of adding a second live region. */}
        {!isOpening && resuming && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Resuming…
          </>
        )}
        {!isOpening && !resuming && recovering && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Retrying…
          </>
        )}
        {!isOpening && !resuming && !recovering && startingNew && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Starting new conversation…
          </>
        )}
      </div>
      {!showBanner && startProgress && (
        <div data-pane-banner className="shrink-0 px-4 pt-3">
          {/* Gate-fixes a11y High finding: `role="status"` made the whole banner an implicit
              polite live region, so a screen reader re-read the ticking "N s" title every
              second for up to 180s. `role="group"` plus a static `aria-label` keeps this an
              ordinary (non-live) landmark; the only announcing channel is the separate
              `startAnnouncement` region below, fired exactly twice (start begins, prompt
              reached), never per-tick. */}
          <Alert role="group" aria-label="Agent start">
            <LoaderCircleIcon aria-hidden className="animate-spin" />
            <AlertTitle>
              {/* Gate-fixes a11y Low finding (cycle 2, widened cycle 6): same kind-based static
                  label as the Session row (SessionList.tsx), instead of always "Starting agent"
                  even while 'queued'/'memory-deferred', whose visible text reads otherwise. */}
              <span className="sr-only">{describeStartProgressLabel(startProgress.kind)}</span>
              <span aria-hidden>{describeStartProgress(startProgress)}</span>
            </AlertTitle>
            {/* Gate-fixes Medium finding (cycle 5): Keep waiting/Cancel used to render only for
                'prompt'/'extended' -- under low memory or a full start queue, a start could sit
                in 'queued'/'memory-deferred' for up to a minute with no way to cancel it at all. */}
            {(startProgress.kind === 'prompt' ||
              startProgress.kind === 'extended' ||
              startProgress.kind === 'queued' ||
              startProgress.kind === 'memory-deferred') && (
              <>
                <AlertDescription>
                  {/* Gate-fixes a11y Low finding (cycle 2): the 'extended' stage has no Keep
                      waiting button, so its description must not still offer one. */}
                  {startProgress.kind === 'prompt'
                    ? 'Still starting. Keep waiting, or cancel?'
                    : startProgress.kind === 'extended'
                      ? 'Still starting. Cancel to stop waiting.'
                      : 'Cancel to stop waiting.'}
                </AlertDescription>
                <div className="col-start-2 mt-2 flex gap-2">
                  {startProgress.kind === 'prompt' && (
                    <Button size="sm" variant="outline" onClick={() => void handleKeepWaitingForStart()}>
                      Keep waiting
                    </Button>
                  )}
                  <Button ref={cancelButtonRef} size="sm" variant="outline" onClick={() => void handleCancelStart()}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Alert>
        </div>
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {startAnnouncement}
      </div>
      {showBanner && (
        <div data-pane-banner className="shrink-0 px-4 pt-3">
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>
              {showTerminatedTitle ? 'Terminated unexpectedly' : describeStopReason(effectiveStopReason, effectiveStopDetail)}
            </AlertTitle>
            {showTerminatedTitle && (
              <AlertDescription>
                Its Conversation ended mid-turn, not a clean stop.
                {effectivePendingToolNames && effectivePendingToolNames.length > 0
                  ? ` Still waiting on ${effectivePendingToolNames.join(', ')}.`
                  : ''}
              </AlertDescription>
            )}
            {canResumeSession(session.status, effectiveStopReason, effectiveTerminatedUnexpectedly, !!session.archivedAt) && (
              // Quality-gate fix (2026-10-08): normal flow (`col-start-2 mt-2`, matching the
              // start-failed/worktree-missing banners below), not `AlertAction` -- `AlertAction`
              // is `absolute top-2 right-2` (alert.tsx), which covered the terminated-unexpectedly
              // description text instead of flowing after it. Recover (when shown) comes FIRST in
              // DOM order: `focusPaneContent`'s generic banner-button query (lib/focus.ts) always
              // focuses the first enabled `[data-pane-banner]` button, and Recover is the safe,
              // non-money-spending one -- Resume sends a real turn and must never be where focus
              // lands by accident.
              <div className="col-start-2 mt-2 flex gap-2">
                {effectiveStopReason === 'agent-exited' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recovering || startingNew || resuming}
                    onClick={() => void handleRecover()}
                  >
                    {recovering ? 'Retrying…' : 'Recover'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  aria-disabled={recovering || startingNew || resuming || undefined}
                  className="aria-disabled:opacity-50"
                  onClick={() => void handleResume()}
                >
                  {resuming ? 'Resuming…' : 'Resume'}
                </Button>
              </div>
            )}
            {effectiveStopReason === 'start-failed' && (
              <div className="col-start-2 mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={recovering || startingNew}
                  onClick={() => void handleRecover()}
                >
                  {recovering ? 'Retrying…' : 'Retry'}
                </Button>
                <Button
                  ref={startNewButtonRef}
                  size="sm"
                  variant="outline"
                  disabled={recovering || startingNew}
                  onClick={() => void handleStartNewConversation()}
                >
                  {startingNew ? 'Starting…' : 'Start new conversation'}
                </Button>
              </div>
            )}
            {effectiveStopReason === 'worktree-missing' && (
              <div className="col-start-2 mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void handleRecreateWorktree()}>
                  Recreate worktree
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleArchive()}>
                  Archive
                </Button>
                <Button
                  ref={deleteBannerButtonRef}
                  size="sm"
                  variant="destructive"
                  onClick={() => setDeleteForId(sessionId)}
                >
                  Delete
                </Button>
              </div>
            )}
          </Alert>
          {/* Gate-fixes a11y Medium finding (cycle 6): moved OUT of `<Alert>` (which has
              `role="alert"`, implying `aria-live="assertive"`/`aria-atomic`) -- toggling this
              used to re-announce the ENTIRE alert assertively on every click (title, Retry/
              Start new, and on expand the whole stderr/omp-log/memory text), interrupting the
              user mid-read. A sibling here never mutates a live region. */}
          {startFailureDetails && (
            <div className="mt-2 pl-6">
              {/* Issue #512 requirement 2 (gate-fixes Medium finding, cycle 5): the stderr/
                  omp-log warnings-and-errors tails and memory figures `buildStartFailure`
                  appends, hidden behind a disclosure instead of always shown inline -- the
                  title above already covers the one-line reason most users need. */}
              <button
                type="button"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen((open) => !open)}
                className="inline-flex min-h-11 items-center px-1 text-xs font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {/* Gate-fixes a11y Low finding (cycle 6): a constant label -- `aria-expanded`
                    already carries the toggle state; flipping the label TOO had a screen reader
                    announce the state twice ("Hide details, expanded"). Gate-fixes a11y Medium
                    finding (cycle 7): `min-h-11`/padding so the tap target meets WCAG 2.5.5 --
                    this was previously just the ~16px-tall inline text. */}
                Details
              </button>
              {/* Gate-fixes a11y Low finding (cycle 7): always rendered (never conditionally
                  mounted/unmounted) with `hidden` toggling visibility instead -- `aria-controls`
                  pointing at an id only present in the DOM while expanded is a dangling
                  reference some assistive technology and validators report. Gate-fixes a11y
                  Medium finding (cycle 7): `aria-label` is prohibited on a bare `<pre>`, which
                  maps to the ARIA `generic` role (ARIA 1.2 forbids naming `generic` elements) --
                  `role="region"` makes the name valid. */}
              <pre
                id={detailsId}
                hidden={!detailsOpen}
                role="region"
                tabIndex={0}
                aria-label="Start failure details"
                className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {startFailureDetails}
              </pre>
            </div>
          )}
        </div>
      )}
      <DeleteDialog
        session={session}
        open={deleteForId === sessionId}
        onOpenChange={(open) => setDeleteForId(open ? sessionId : null)}
        onDeleted={() => {
          // FR-016: deleting the Session shown in this pane closes the pane itself (a no-op when
          // there is no split to close down to), not just a focus move inside it.
          useSplitStore.getState().closePane(paneIndex)
          // Quality-gate remediation (code-reviewer Low, gate-4): deferred one frame -- while the
          // session list is collapsed (inert), `focusSessionsNav`'s own pane fallback can land on
          // THIS pane, which `closePane` above just scheduled to unmount, before React has
          // actually committed that change.
          requestAnimationFrame(() => focusSessionsNav())
        }}
        onCancelled={() => {
          if (deleteBannerButtonRef.current?.isConnected) deleteBannerButtonRef.current.focus()
          else focusSessionsNav()
        }}
      />
      <div className="relative isolate min-h-0 flex-1 overflow-hidden [container-type:size]">
        {showWatermark && <BrandWatermark variant="live" />}
        <Transcript sessionId={sessionId} />
      </div>
      <MessageInput
        key={sessionId}
        sessionId={sessionId}
        stopReason={effectiveStopReason}
        stopDetail={effectiveStopDetail}
        autoFocusOnMount={autoFocusRef.current}
      />
    </div>
  )
}
