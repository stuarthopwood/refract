import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { MessageSquareIcon, PaperclipIcon } from 'lucide-react'
import { FocusedPaneTint } from './FocusedPaneTint'
import { StopBanner } from './StopBanner'
import { PausedBody } from './PausedBody'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { cn } from '@/lib/utils'
import { focusPaneContent, focusSessionsNav, isFocusStranded } from '@/lib/focus'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import {
  notify,
  useChatScrollStore,
  useCommandsStore,
  useDraftStore,
  useHolidayStore,
  usePendingRequestsStore,
  useQueueStore,
  useReadoutStore,
  useSessionsStore,
  useSettingsStore,
  useSplitStore,
  useSubagentPanelStore
} from '@/state'
import type { Result, SessionSnapshot, SessionStatusEvent } from '../../../shared/ipc'
import { attachResolvedPaths, remainingAttachmentSlots } from './attachDroppedPaths'
import type { ResolvedDropItem } from './attachDroppedPaths'
import { canResumeSession, resumeSession } from './resume'
import { applySnapshot } from './applySnapshot'
import { closeChatPane } from './closeChatPane'
import { READY_CEILING_MS, type SessionStartProgress } from '../../../shared/model'
import { describeStartProgressLabel } from '@/features/sessions/startProgressDisplay'
import { BrandWatermark } from './BrandWatermark'
import { useEnterOnSwitch } from '@/components/useEnterOnSwitch'
import { HolidayAmbientLoop } from '../holidays/HolidayAmbientLoop'
import { HolidayEmptyStateLine } from '../holidays/HolidayEmptyStateLine'
import { HOLIDAY_CONTENT } from '../holidays/holidayContent'
import { ChatHeader } from './ChatHeader'
import { MessageInput } from './MessageInput'
import { ComposerAboveStack } from './ComposerAboveStack'
import { useQueuedMessages } from './useQueuedMessages'
import { SessionStartNotice } from './SessionStartNotice'
import { pickStartingMessageIndex, STARTING_MESSAGES, STARTING_MESSAGE_EMOJI } from './startingMessages'
import { Transcript } from './Transcript'
import { useEffectiveStartProgress } from './useEffectiveStartProgress'
import { useTauriFileDrop } from './useTauriFileDrop'

type StopReason = SessionStatusEvent['stopReason']

interface StopInfo {
  reason?: StopReason
  detail?: string
  terminatedUnexpectedly?: boolean
  pendingToolNames?: string[]
}

/** `SessionSummary` (the sessions-store list row) carries `status` but not `stopReason`/ `stopDetail` (only `SessionRuntimeView` does). */
export function describeStopReason(reason: StopReason, detail?: string): string {
  switch (reason) {
    case 'agent-exited':
      return `The agent stopped (${detail ?? 'unknown exit code'}).`
    case 'worktree-missing':
      return `Worktree missing: ${detail ?? 'the worktree folder is gone'}`
    case 'start-failed':
      return detail?.split('\n', 1)[0] || 'The agent failed to start.'
    default:
      return 'The agent is stopped.'
  }
}

interface ChatPaneProps {
  sessionId: string
  paneIndex: number
  reservesWindowControls: boolean
  otherSession?: { id: string; name: string } | null
  showWatermark?: boolean
  showAmbientLoop?: boolean
}

export function ChatPane({ sessionId, paneIndex, reservesWindowControls, otherSession, showWatermark, showAmbientLoop }: ChatPaneProps) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const deleting = useSessionsStore((s) => s.deletingIds.has(sessionId))
  const startSeq = useSessionsStore((s) => s.startSeq[sessionId] ?? 0)
  const queued = useQueuedMessages(sessionId)
  const isPristine = useSplitStore((s) => s.pristineIds.has(sessionId))
  const isSplit = useSplitStore((s) => s.paneSessionIds.length === 2)
  const showSplit = isSplit && !otherSession
  const isFocused = useSplitStore((s) => s.paneSessionIds.length < 2 || s.focusedIndex === paneIndex)
  const focusMoveSignal = useSplitStore((s) => s.focusMoveSignal)
  const focusPane = useSplitStore((s) => s.focusPane)
  const openInSplit = useSplitStore((s) => s.openInSplit)
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const activeHolidayId = useHolidayStore((s) => s.activeHoliday)
  const holidayEntry = holidayTouches !== 'off' && activeHolidayId ? HOLIDAY_CONTENT[activeHolidayId] : null
  const [stopInfo, setStopInfo] = useState<StopInfo>({})
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const startProgress = session?.startProgress
  // A Session with no `session` yet never reaches the render that reads this, so the `true` fallback never shows.
  const hasHistory = session ? session.currentConversation !== null : true
  const effectiveStopReason = session ? (isPristine ? session.stopReason : stopInfo.reason) : undefined
  const effectiveTerminatedUnexpectedly = session
    ? isPristine
      ? !!session.terminatedUnexpectedly
      : !!stopInfo.terminatedUnexpectedly
    : false
  const showBanner =
    !!session &&
    !startProgress &&
    session.status === 'stopped' &&
    ((!!effectiveStopReason && effectiveStopReason !== 'not-started') || effectiveTerminatedUnexpectedly)
  const effectiveStartProgress = useEffectiveStartProgress(sessionId, session?.status, startProgress)
  const [startAnnouncement, announceStart] = useClearedAnnouncement()
  const prevStartProgressKindRef = useRef<{ sessionId: string; kind: SessionStartProgress['kind'] | undefined }>({
    sessionId,
    kind: undefined
  })
  const activeStartingMessageRef = useRef<Map<string, number>>(new Map())
  const lastStartingMessageRef = useRef<Map<string, number>>(new Map())
  const [startingMessageIndex, setStartingMessageIndex] = useState<number | undefined>(undefined)
  const startingMessagePool = useMemo(() => {
    if (!holidayEntry) return { messages: STARTING_MESSAGES, emoji: STARTING_MESSAGE_EMOJI }
    return {
      messages: [...STARTING_MESSAGES, ...holidayEntry.startingMessages],
      emoji: [...STARTING_MESSAGE_EMOJI, ...holidayEntry.startingMessages.map(() => holidayEntry.emoji)]
    }
  }, [holidayEntry])
  const startingMessageText = startingMessageIndex !== undefined ? (startingMessagePool.messages[startingMessageIndex] ?? STARTING_MESSAGES[0]) : undefined
  const startingMessageEmoji = startingMessageIndex !== undefined ? (startingMessagePool.emoji[startingMessageIndex] ?? STARTING_MESSAGE_EMOJI[0]) : undefined
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const cancelFocusPendingRef = useRef<{ focusedAtStart: Element | null; hadFocus: boolean } | null>(null)
  const [recoveringId, setRecoveringId] = useState<string | null>(null)
  const [startingNewId, setStartingNewId] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [deleteForId, setDeleteForId] = useState<string | null>(null)
  const deleteBannerButtonRef = useRef<HTMLButtonElement>(null)
  const startNewButtonRef = useRef<HTMLButtonElement>(null)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const chatPaneRef = useRef<HTMLDivElement>(null)
  useEnterOnSwitch(sessionId, 'fade', chatPaneRef)
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

  useEffect(
    () =>
      window.refract.onSessionStatus((event) => {
        if (event.sessionId !== sessionIdRef.current) return
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

  // Avoids a pane switch briefly painting the incoming Session's pane with the outgoing Session's stale picked text.
  useLayoutEffect(() => {
    const prev = prevStartProgressKindRef.current
    const previousKind = prev.sessionId === sessionId ? prev.kind : undefined
    for (const id of Array.from(activeStartingMessageRef.current.keys())) {
      if (id === sessionId) continue
      const stillOpening = useSessionsStore.getState().startingIds.has(id)
      const hasRealStartProgress = !!useSessionsStore.getState().sessions.find((s) => s.id === id)?.startProgress
      if (!stillOpening && !hasRealStartProgress) {
        activeStartingMessageRef.current.delete(id)
      }
    }
    if (!effectiveStartProgress) {
      activeStartingMessageRef.current.delete(sessionId)
      setStartingMessageIndex(undefined)
    } else {
      const isRetryTransition =
        (previousKind === 'prompt' || previousKind === 'extended') && effectiveStartProgress.kind === 'queued'
      const active = activeStartingMessageRef.current.get(sessionId)
      if (active !== undefined && !isRetryTransition) {
        setStartingMessageIndex(active)
      } else {
        const prevIndex = lastStartingMessageRef.current.get(sessionId)
        const nextIndex = pickStartingMessageIndex(prevIndex, startingMessagePool.messages.length)
        activeStartingMessageRef.current.set(sessionId, nextIndex)
        lastStartingMessageRef.current.set(sessionId, nextIndex)
        setStartingMessageIndex(nextIndex)
      }
    }
    if (session && startProgress?.kind === 'prompt' && !showBanner && previousKind === undefined) {
      announceStart(
        `${session.name} is still starting after ${Math.round(startProgress.elapsedMs / 1000)} seconds. Keep waiting or cancel.`
      )
    } else if (session && startProgress?.kind === 'extended' && previousKind === undefined) {
      announceStart(`${session.name} is still starting. Cancel to stop waiting.`)
    } else if (session && startProgress && previousKind === undefined) {
      if (recoveringId !== sessionId && startingNewId !== sessionId && resumingId !== sessionId) {
        announceStart(`${describeStartProgressLabel(startProgress.kind)}: ${session.name}`)
      }
    } else if (session && (previousKind === 'prompt' || previousKind === 'extended') && startProgress?.kind === 'queued') {
      announceStart(`Retrying start for ${session.name}`)
    } else if (session && !showBanner && startProgress?.kind === 'prompt' && previousKind !== 'prompt') {
      announceStart(
        `${session.name} is still starting after ${Math.round(startProgress.elapsedMs / 1000)} seconds. Keep waiting or cancel.`
      )
    }
    prevStartProgressKindRef.current = { sessionId, kind: startProgress?.kind }
  }, [effectiveStartProgress, startProgress, session, announceStart, showBanner, recoveringId, startingNewId, resumingId, sessionId, startingMessagePool])

  useEffect(() => {
    setStopInfo({})
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
        const commandsResult = await window.refract.chat.commands(sessionId)
        if (!cancelled && commandsResult.ok) {
          useCommandsStore.getState().setForSession(sessionId, commandsResult.value)
        }
      } catch (error) {
        if (!cancelled) console.error('[refract] opening session snapshot failed', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, startSeq])

  useEffect(() => {
    setDetailsOpen(false)
  }, [stopInfo.detail])

  useEffect(() => {
    if (session) return
    const raf = requestAnimationFrame(() => {
      const stillMissing = !useSessionsStore.getState().sessions.some((s) => s.id === sessionId)
      if (stillMissing) useSplitStore.getState().closePane(paneIndex)
    })
    return () => cancelAnimationFrame(raf)
  }, [session, sessionId, paneIndex])

  useEffect(() => {
    if (session) return
    const panelState = useSubagentPanelStore.getState()
    if (panelState.sessionId === sessionId) panelState.closePanel({ restoreFocus: false })
  }, [sessionId, session])

  function handleFocusPane(): void {
    focusPane(paneIndex)
  }

  const prevMoveSignalRef = useRef(focusMoveSignal)
  useEffect(() => {
    const prevSignal = prevMoveSignalRef.current
    prevMoveSignalRef.current = focusMoveSignal
    if (!isSplit || !isFocused || prevSignal === focusMoveSignal) return
    if (chatPaneRef.current?.contains(document.activeElement)) return
    focusPaneContent(chatPaneRef.current)
  }, [isFocused, isSplit, focusMoveSignal])

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
  useEffect(() => {
    if (!showBanner) return
    if (!chatHadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (stranded) focusPaneContent(chatPaneRef.current)
    })
  }, [showBanner, effectiveStopReason])
  const prevInteractiveBannerRef = useRef(false)
  useEffect(() => {
    const wasInteractive = prevInteractiveBannerRef.current
    const isInteractive =
      !showBanner &&
      (startProgress?.kind === 'prompt' ||
        startProgress?.kind === 'extended' ||
        startProgress?.kind === 'queued' ||
        startProgress?.kind === 'memory-deferred')
    prevInteractiveBannerRef.current = isInteractive
    if (!wasInteractive || isInteractive) return
    if (cancelFocusPendingRef.current && session?.status === 'stopped') return
    requestAnimationFrame(() => {
      const active = document.activeElement
      const stranded = isFocusStranded(active, chatPaneRef.current)
      if (stranded) focusPaneContent(chatPaneRef.current)
    })
  }, [startProgress?.kind, showBanner, session?.status])
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
      if (stranded || active === chatPaneRef.current) focusPaneContent(chatPaneRef.current)
    })
  }, [showBanner, startProgress, sessionId, recoveringId, startingNewId, resumingId])

  if (!session) {
    return (
      <Empty className="relative isolate h-full [container-type:size]">
        {showWatermark && <BrandWatermark variant="live" />}
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyTitle>No Session selected</EmptyTitle>
          <EmptyDescription>Select a Session or create one.</EmptyDescription>
          <HolidayEmptyStateLine className="mt-1 block text-xs text-muted-foreground" />
        </EmptyHeader>
      </Empty>
    )
  }

  const recovering = recoveringId === sessionId
  const startingNew = startingNewId === sessionId
  const resuming = resumingId === sessionId
  const effectiveStopDetail = isPristine ? undefined : stopInfo.detail
  const startFailureDetails =
    effectiveStopReason === 'start-failed' && effectiveStopDetail ? effectiveStopDetail.split('\n').slice(1).join('\n').trim() : ''
  const effectivePendingToolNames = isPristine ? undefined : stopInfo.pendingToolNames
  const showTerminatedTitle =
    effectiveTerminatedUnexpectedly && effectiveStopReason !== 'worktree-missing' && effectiveStopReason !== 'start-failed'
  // Restores focus only when it was in this pane, never on first load or when focus was elsewhere (session list, a dialog).
  if (prevSessionIdRef.current !== sessionId) {
    autoFocusRef.current = prevSessionIdRef.current !== null && chatHadFocusRef.current
    prevSessionIdRef.current = sessionId
  }

  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const dragDepthRef = useRef(0)
  const composerDisabled = session.status === 'stopped' && effectiveStopReason !== 'not-started' && effectiveStopReason !== undefined
  useTauriFileDrop({ sessionId, paneRef: chatPaneRef, composerDisabled, dragDepthRef, setIsDraggingFiles })

  function hasFilesPayload(event: ReactDragEvent): boolean {
    return Array.from(event.dataTransfer.types).includes('Files')
  }
  function handlePaneDragEnter(event: ReactDragEvent) {
    if (!hasFilesPayload(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }
  function handlePaneDragOver(event: ReactDragEvent) {
    if (!hasFilesPayload(event)) return
    event.preventDefault() // required for `onDrop` to ever fire
    event.dataTransfer.dropEffect = 'copy'
  }
  function handlePaneDragLeave(event: ReactDragEvent) {
    if (!hasFilesPayload(event)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDraggingFiles(false)
  }
  async function handlePaneDrop(event: ReactDragEvent) {
    if (!hasFilesPayload(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0 && !composerDisabled) return
    const remainingSlots = remainingAttachmentSlots(sessionId)
    const capped = files.slice(0, remainingSlots)
    const resolved: ResolvedDropItem[] = []
    const preFailed: { name: string }[] = []
    for (const file of capped) {
      try {
        // A browser-dragged image with no on-disk backing file has no `getPathForFile` equivalent either; refused like any other unresolvable path (never a silent drop).
        if (!window.refract.attachments.getPathForFile) throw new Error('getPathForFile is not available')
        resolved.push({ name: file.name, filePath: window.refract.attachments.getPathForFile(file) })
      } catch {
        preFailed.push({ name: file.name })
      }
    }
    await attachResolvedPaths(sessionId, resolved, preFailed, files.length, remainingSlots, composerDisabled)
  }

  async function handleRecover() {
    const recoveringFor = sessionId
    const focusedAtStart = document.activeElement
    const hadFocus = !!chatPaneRef.current?.contains(focusedAtStart)
    setRecoveringId(recoveringFor)
    const result = await window.refract.sessions.recover(recoveringFor)
    setRecoveringId(id => (id === recoveringFor ? null : id))
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
    }
    requestAnimationFrame(maybeRestoreFocus)
  }

  async function handleResume() {
    if (recovering || startingNew || resuming) return
    const resumingFor = sessionId
    const focusedAtStart = document.activeElement
    const hadFocus = !!chatPaneRef.current?.contains(focusedAtStart)
    setResumingId(resumingFor)
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
          pendingToolNames: result.value.runtime.pendingToolNames
        })
      }
      requestAnimationFrame(maybeRestoreFocus)
    } catch (err) {
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
    const previousScroll = useChatScrollStore.getState().bySession[startingFor]
    useChatScrollStore.getState().clear(startingFor)
    useChatScrollStore.getState().setInFlight(startingFor, true)
    let result: Result<SessionSnapshot>
    try {
      result = await window.refract.conversations.startNew(startingFor)
    } finally {
      // Always released, even if the IPC call rejects (a handler throw rejects `invoke`): otherwise `record()` would stay a no-op for this Session for the app's lifetime.
      useChatScrollStore.getState().setInFlight(startingFor, false)
    }
    setStartingNewId(id => (id === startingFor ? null : id))
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

  async function handleKeepWaitingForStart() {
    const focusedAtStart = document.activeElement
    const startedForSessionId = sessionId
    const wasPrompt = startProgress?.kind === 'prompt'
    const elapsedMsAtClick = wasPrompt && startProgress ? startProgress.elapsedMs : 0
    const result = await window.refract.sessions.keepWaitingForStart(sessionId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (sessionIdRef.current !== startedForSessionId) return
    if (!wasPrompt) return
    const minutesLeft = Math.max(1, Math.round((READY_CEILING_MS - elapsedMsAtClick) / 60_000))
    announceStart(`Keep waiting: about ${minutesLeft} more minute${minutesLeft === 1 ? '' : 's'}`)
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
      onDragEnter={handlePaneDragEnter}
      onDragOver={handlePaneDragOver}
      onDragLeave={handlePaneDragLeave}
      onDrop={(event) => void handlePaneDrop(event)}
      className="relative isolate flex h-full flex-col overflow-hidden"
    >
      {isDraggingFiles && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-ring bg-background/90 text-sm text-foreground"
        >
          <PaperclipIcon className="size-4" aria-hidden />
          {composerDisabled ? 'This session is not accepting input right now' : 'Drop files to attach'}
        </div>
      )}
      <FocusedPaneTint active={showSplit && isFocused} />
      <ChatHeader
        sessionId={sessionId}
        focused={showSplit ? isFocused : undefined}
        onClose={() => closeChatPane(paneIndex)}
        otherSessionName={otherSession?.name}
        onSwapToOther={otherSession ? () => openInSplit(otherSession.id) : undefined}
        reservesWindowControls={reservesWindowControls}
      />
      <div
        role="status"
        className={cn(
          'flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-muted-foreground',
          !recovering && !startingNew && !resuming && 'sr-only'
        )}
      >
        {resuming && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Resuming…
          </>
        )}
        {!resuming && recovering && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Retrying…
          </>
        )}
        {!resuming && !recovering && startingNew && (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
            Starting new conversation…
          </>
        )}
      </div>
      <div data-start-announcement aria-live="polite" aria-atomic="true" className="sr-only">
        {startAnnouncement}
      </div>
      {showBanner && (
        <StopBanner
          stopReason={effectiveStopReason}
          stopDetail={effectiveStopDetail}
          showTerminatedTitle={showTerminatedTitle}
          pendingToolNames={effectivePendingToolNames}
          canResume={canResumeSession(session.status, effectiveStopReason, effectiveTerminatedUnexpectedly, !!session.archivedAt)}
          busy={{ recovering, startingNew, resuming }}
          startFailureDetails={startFailureDetails}
          detailsOpen={detailsOpen}
          detailsId={detailsId}
          onToggleDetails={() => setDetailsOpen((open) => !open)}
          onRecover={() => void handleRecover()}
          onResume={() => void handleResume()}
          onStartNew={() => void handleStartNewConversation()}
          onRecreateWorktree={() => void handleRecreateWorktree()}
          onArchive={() => void handleArchive()}
          onDelete={() => setDeleteForId(sessionId)}
          startNewButtonRef={startNewButtonRef} deleteButtonRef={deleteBannerButtonRef} deleteDisabled={deleting}
        />
      )}
      <DeleteDialog
        session={session}
        open={deleteForId === sessionId}
        onOpenChange={(open) => setDeleteForId(open ? sessionId : null)}
        onDeleted={() => {
          useSplitStore.getState().closePane(paneIndex)
          requestAnimationFrame(() => focusSessionsNav())
        }}
        onCancelled={() => {
          if (deleteBannerButtonRef.current?.isConnected) deleteBannerButtonRef.current.focus()
          else focusSessionsNav()
        }}
      />
      <PausedBody sessionId={sessionId}>
      <div className="relative isolate min-h-0 flex-1 overflow-hidden [container-type:size]">
        {showWatermark && <BrandWatermark variant="live" allowHoliday={false} />}
        {showAmbientLoop && <HolidayAmbientLoop avoidTextColumn />}
        <Transcript
          sessionId={sessionId}
          hasHistory={hasHistory}
          startNotice={
            !showBanner && effectiveStartProgress
              ? (dimmed: boolean) => (
                  <SessionStartNotice
                    startProgress={effectiveStartProgress}
                    message={startingMessageText}
                    emoji={startingMessageEmoji}
                    cancelButtonRef={cancelButtonRef}
                    onKeepWaiting={() => void handleKeepWaitingForStart()}
                    onCancel={() => void handleCancelStart()}
                    dimmed={dimmed}
                  />
                )
              : undefined
          }
        />
      </div>
      <ComposerAboveStack key={`todo-${sessionId}`} sessionId={sessionId} stoppedBarAllowed={!showBanner && !effectiveStartProgress} queued={queued} />
      <MessageInput key={`composer-${sessionId}`} queued={queued} sessionId={sessionId}
        stopReason={effectiveStopReason} stopDetail={effectiveStopDetail}
        autoFocusOnMount={autoFocusRef.current} />
      </PausedBody>
    </div>
  )
}
