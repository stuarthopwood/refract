// The chat pane (docs/DESIGN.md "Chat", "Layout"): header, transcript, and message box for one
// Session, plus the persistent stopped-Session banner (docs/DESIGN.md "Feedback and errors").
// Spec 005: generalised from a singleton reading `visibleSessionId` to an explicit `sessionId`/
// `paneIndex` pair, so one or two of these can render side by side (App.tsx).
import { useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, MessageSquareIcon } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { cn } from '@/lib/utils'
import { focusPaneContent, focusSessionsNav } from '@/lib/focus'
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
import { DEFAULT_RESUME_INSTRUCTION } from '../../../shared/model'
import { canResumeSession, resumeSession } from './resume'
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


/** Fans a `SessionSnapshot` (returned by `sessions.open`/`sessions.recover`/`conversations.*`,
 * contracts/ipc.md) out to the transcript, queue, and pending-request stores for that Session.
 * Shared by ChatPane, ConversationSwitcher, and MessageInput's "not-started" open-then-send path. */
export function applySnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  useTranscriptStore.getState().reset(sessionId, snapshot.runtime.transcript)
  useQueueStore.getState().apply(sessionId, snapshot.runtime.queue.followUp, snapshot.runtime.queue.steering)
  usePendingRequestsStore.getState().setForSession(sessionId, snapshot.runtime.pending)
  // Spec 004: the chip row's initial bundle, including the current turn's subagents as of this
  // snapshot (T024 live-finding fix: seeding `[]` here unconditionally wiped the Subagent panel's
  // list back to empty on every re-application of a snapshot -- a Settings round-trip or a
  // session switch away and back both remount ChatPane and so re-run this -- even though the
  // finished turn's subagents were still live in `SessionAgent.runtime.subagents` and its own
  // `readout.subagentCount` kept showing the real count the whole time); live updates still fold
  // on top via `subagents:update`.
  useReadoutStore.getState().reset(sessionId, snapshot.readout, snapshot.subagents)
  // Spec 004 FR-020: a Session switch leaves no stale subagent panel open for a different
  // Session's turn. Medium remediation (code-reviewer): only actually reset when this snapshot
  // is for a DIFFERENT Session than the panel was last open for -- a Settings round-trip (or any
  // other remount that re-applies a snapshot for the Session already visible, e.g. ChatPane
  // remounting on return from Settings) must never drop a panel the user deliberately opened for
  // a turn still in progress just because `sessions.open` ran again for the same Session.
  if (useSubagentPanelStore.getState().sessionId !== sessionId) {
    useSubagentPanelStore.getState().reset()
  }
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
      return detail || 'The agent failed to start.'
    default:
      return 'The agent is stopped.'
  }
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
  const closePane = useSplitStore((s) => s.closePane)
  const openInSplit = useSplitStore((s) => s.openInSplit)
  const [stopInfo, setStopInfo] = useState<StopInfo>({})
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
      }),
    []
  )

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

  // FR-016: a Session that no longer exists at all (`sessions.delete`, never just archived)
  // closes its own pane -- `split-store.ts`'s own `pruneDeleted` (reacting to the next
  // `sessions.list()` refresh) is the belt to this braces, for immediate responsiveness without
  // waiting on that round trip.
  useEffect(() => {
    if (session) return
    useSplitStore.getState().closePane(paneIndex)
  }, [session, paneIndex])

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
  const effectiveStopReason = isPristine ? session.stopReason : stopInfo.reason
  const effectiveStopDetail = isPristine ? undefined : stopInfo.detail
  // Issue #510 slice 2 (PLAN.md row A0): independent of `effectiveStopReason` -- this is what
  // still flags a Session reopened after a Refract crash, which only ever carries `stopReason:
  // 'not-started'` (no live `onExit` ever ran this run to set `agent-exited`).
  const effectiveTerminatedUnexpectedly = isPristine ? !!session.terminatedUnexpectedly : !!stopInfo.terminatedUnexpectedly
  const effectivePendingToolNames = isPristine ? undefined : stopInfo.pendingToolNames
  // `not-started` is idle-and-asleep, not an error (data-model.md) UNLESS the Conversation tail
  // shows it died mid-turn, in which case it still needs a banner (just no Recover action yet --
  // #509 adds the Resume button for exactly this case).
  const showBanner =
    session.status === 'stopped' &&
    ((!!effectiveStopReason && effectiveStopReason !== 'not-started') || effectiveTerminatedUnexpectedly)
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
      const stranded = !active || active === document.body || !active.isConnected
      if (!stranded && active !== focusedAtStart) return
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
    }
    // The banner (and its focused Recover/Retry button) unmounts once the snapshot clears the
    // stop reason, dropping focus to <body>. Waits one frame for the fresh content (textarea or
    // a still-stopped banner) to mount before reclaiming focus.
    requestAnimationFrame(maybeRestoreFocus)
  }

  // Issue #509 (PLAN.md row A2g): recovers the agent AND sends the default resume instruction as
  // a real turn (`resumeSession`, shared with the session-list row's own Resume button). Mirrors
  // `handleRecover`'s focus-restore discipline exactly; the only difference is the shared helper
  // also sends the turn, so a successful result still carries the post-recover snapshot (from
  // before that turn settles) for `stopInfo`.
  async function handleResume() {
    const resumingFor = sessionId
    const focusedAtStart = document.activeElement
    const hadFocus = !!chatPaneRef.current?.contains(focusedAtStart)
    setResumingId(resumingFor)
    const result = await resumeSession(resumingFor)
    setResumingId(id => (id === resumingFor ? null : id))
    const maybeRestoreFocus = () => {
      if (!hadFocus || sessionIdRef.current !== resumingFor) return
      const active = document.activeElement
      const stranded = !active || active === document.body || !active.isConnected
      if (!stranded && active !== focusedAtStart) return
      focusPaneContent(chatPaneRef.current)
    }
    if (!result.ok) {
      notify(result.error)
      requestAnimationFrame(maybeRestoreFocus)
      return
    }
    if (sessionIdRef.current === resumingFor) {
      setStopInfo({
        reason: result.value.runtime.stopReason,
        detail: result.value.runtime.stopDetail,
        terminatedUnexpectedly: result.value.runtime.terminatedUnexpectedly
      })
    }
    requestAnimationFrame(maybeRestoreFocus)
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
      const stranded = !active || active === document.body || !active.isConnected
      if (!stranded && active !== focusedAtStart) return
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
    }
    requestAnimationFrame(maybeRestoreFocus)
  }

  async function handleRecreateWorktree() {
    const result = await window.refract.sessions.recreateWorktree(sessionId)
    if (!result.ok) notify(result.error)
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
        onClose={
          isSplit
            ? () => {
                closePane(paneIndex)
                // Quality-gate remediation (accessibility-auditor, High): closing a pane via
                // keyboard previously dropped focus to <body> -- both panes unmount/remount
                // across this structural layout change (App.tsx swaps the whole subtree), so
                // there is no previous-instance ref to refocus. Waits one frame for the
                // survivor's fresh single-pane ChatPane/MessageInput to mount, then focuses its
                // own message box. Round 2 (accessibility-auditor, Medium): falls back past a
                // disabled textarea (a stopped survivor Session) to the banner's own button,
                // via the same `focusPaneContent` helper as the focus-move effect above.
                requestAnimationFrame(() => {
                  focusPaneContent(
                    document.querySelector<HTMLElement>('[role="region"][aria-label$=" chat"]')
                  )
                })
              }
            : undefined
        }
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
            {canResumeSession(session.status, effectiveStopReason, effectiveTerminatedUnexpectedly) && (
              <AlertAction>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recovering || startingNew || resuming}
                    onClick={() => void handleResume()}
                  >
                    {resuming ? 'Resuming…' : 'Resume'}
                  </Button>
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
                </div>
              </AlertAction>
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
