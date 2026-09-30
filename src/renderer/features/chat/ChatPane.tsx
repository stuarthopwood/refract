// The chat pane (docs/DESIGN.md "Chat", "Layout"): header, transcript, and message box for the
// visible Session, plus the persistent stopped-Session banner (docs/DESIGN.md "Feedback and
// errors"). T025 (Transcript) and T028/T029 (RequestCard, inline in the transcript) land
// alongside this file; this owns only the pane's own composition.
import { useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, MessageSquareIcon } from 'lucide-react'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { notify, useCommandsStore, usePendingRequestsStore, useQueueStore, useSessionsStore, useTranscriptStore } from '@/state'
import type { SessionSnapshot, SessionStatusEvent } from '../../../shared/ipc'
import { ChatHeader } from './ChatHeader'
import { MessageInput } from './MessageInput'
import { Transcript } from './Transcript'

type StopReason = SessionStatusEvent['stopReason']

interface StopInfo {
  reason?: StopReason
  detail?: string
}

/** Fans a `SessionSnapshot` (returned by `sessions.open`/`sessions.recover`/`conversations.*`,
 * contracts/ipc.md) out to the transcript, queue, and pending-request stores for that Session.
 * Shared by ChatPane, ConversationSwitcher, and MessageInput's "not-started" open-then-send path. */
export function applySnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  useTranscriptStore.getState().reset(sessionId, snapshot.runtime.transcript)
  useQueueStore.getState().apply(sessionId, snapshot.runtime.queue.followUp, snapshot.runtime.queue.steering)
  usePendingRequestsStore.getState().setForSession(sessionId, snapshot.runtime.pending)
}

/** `SessionSummary` (the sessions-store list row) carries `status` but not `stopReason`/
 * `stopDetail` (only `SessionRuntimeView` does). This is the one place that tracks them for the
 * visible Session: seeded from the snapshot `sessions.open`/`sessions.recover` return, kept live
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

export function ChatPane() {
  const visibleSessionId = useSessionsStore((s) => s.visibleSessionId)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.visibleSessionId))
  // bug report point 4: while `sessions-store.ts`'s `open()` is in flight for this Session (a
  // fresh click, or a not-started Session cold-starting its agent), show that here too -- not
  // just as the list row's spinner -- since the transcript would otherwise just read "No
  // messages yet" for the ~16s a cold start takes.
  const isOpening = useSessionsStore((s) => s.visibleSessionId !== null && s.openingIds.has(s.visibleSessionId))
  const [stopInfo, setStopInfo] = useState<StopInfo>({})
  const [recovering, setRecovering] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const visibleSessionIdRef = useRef(visibleSessionId)
  visibleSessionIdRef.current = visibleSessionId

  // Live updates to the visible Session's stop reason (e.g. the agent exits while it is open).
  useEffect(
    () =>
      window.pinion.onSessionStatus((event) => {
        if (event.sessionId !== visibleSessionIdRef.current) return
        setStopInfo({ reason: event.stopReason, detail: event.stopDetail })
      }),
    []
  )

  // Asks for a full snapshot whenever the visible Session changes (contracts/ipc.md: "the
  // renderer ... asks for a full snapshot via sessions.open when it switches"). Also covers the
  // initial stop reason for a Session that was already stopped before this pane saw it.
  useEffect(() => {
    if (!visibleSessionId) return
    setStopInfo({})
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await useSessionsStore.getState().open(visibleSessionId)
        if (cancelled || !snapshot) return
        applySnapshot(visibleSessionId, snapshot)
        setStopInfo({ reason: snapshot.runtime.stopReason, detail: snapshot.runtime.stopDetail })
        // `commands:update` only pushes on the next `available_commands_update` frame from
        // OMP (SessionAgent.ts), which may not arrive again for a Session that was already
        // running before this pane (re)mounted -- e.g. a warm switch back, or a renderer
        // reload while the agent stayed up. Without this, the slash menu's `aria-controls`
        // points at a listbox that never renders (SlashMenu.tsx renders no id when the
        // command list is empty), and typing `/` shows "No matching commands" forever.
        const commandsResult = await window.pinion.chat.commands(visibleSessionId)
        if (!cancelled && commandsResult.ok) {
          useCommandsStore.getState().setForSession(visibleSessionId, commandsResult.value)
        }
      } catch (error) {
        // Defense in depth: a throw here (e.g. a future `sessionsStore.open` regression) must
        // not silently strand the transcript on "No messages yet" forever, the way the missing
        // `window.pinion.sessions.setVisible` bridge method did (see sessions-store.ts).
        if (!cancelled) console.error('[pinion] opening session snapshot failed', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visibleSessionId])

  if (!visibleSessionId || !session) {
    return (
      <Empty className="h-full">
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

  const sessionId = session.id
  // `not-started` is idle-and-asleep, not an error (data-model.md); it gets no banner.
  const showBanner = session.status === 'stopped' && !!stopInfo.reason && stopInfo.reason !== 'not-started'

  async function handleRecover() {
    setRecovering(true)
    const result = await window.pinion.sessions.recover(sessionId)
    setRecovering(false)
    if (!result.ok) {
      notify(result.error)
      return
    }
    applySnapshot(sessionId, result.value)
    setStopInfo({ reason: result.value.runtime.stopReason, detail: result.value.runtime.stopDetail })
  }

  async function handleRecreateWorktree() {
    const result = await window.pinion.sessions.recreateWorktree(sessionId)
    if (!result.ok) notify(result.error)
  }

  async function handleArchive() {
    const result = await window.pinion.sessions.archive(sessionId)
    if (!result.ok) notify(result.error)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ChatHeader sessionId={sessionId} />
      {isOpening && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-state-working" />
          Starting the agent…
        </div>
      )}
      {showBanner && (
        <div className="shrink-0 px-4 pt-3">
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>{describeStopReason(stopInfo.reason, stopInfo.detail)}</AlertTitle>
            {stopInfo.reason === 'agent-exited' && (
              <AlertAction>
                <Button size="sm" variant="outline" disabled={recovering} onClick={() => void handleRecover()}>
                  Recover
                </Button>
              </AlertAction>
            )}
            {stopInfo.reason === 'worktree-missing' && (
              <div className="col-start-2 mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void handleRecreateWorktree()}>
                  Recreate worktree
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleArchive()}>
                  Archive
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
                  Delete
                </Button>
              </div>
            )}
          </Alert>
        </div>
      )}
      <DeleteDialog session={session} open={deleteOpen} onOpenChange={setDeleteOpen} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <Transcript />
      </div>
      <MessageInput sessionId={sessionId} stopReason={stopInfo.reason} stopDetail={stopInfo.detail} />
    </div>
  )
}
