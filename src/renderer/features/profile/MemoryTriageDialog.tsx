// The low-memory alert row's "Triage" dialog (issue #560, spec 001 FR-037): lists every Session
// whose agent is idle -- never one that is mid-turn ('working') or waiting on the user
// ('needs-you'), and never one already 'stopped' -- with a confirmed Stop per Session plus one
// "Stop idle" action that stops every listed Session at once. No per-agent memory figure is
// shown: no per-process memory API exists anywhere in src-tauri today, and none is added by
// this story. Stopping never happens without the user confirming first (FR-037), matching
// DeleteDialog.tsx/ReviewDialog.tsx's own "Dialog with a stacked AlertDialog confirmation"
// pattern: the confirm AlertDialogs are driven by local state, not an AlertDialogTrigger,
// because the same confirmation needs to know which button opened it for focus-restore
// (DeleteDialog.tsx's own ref convention).
//
// Quality-gate remediation (round 1, four reviewers, confirmed live by a CDP run): five separate
// issues, all fixed here together since they all touch the same two confirm flows.
// 1. Busy guards (DeleteDialog.tsx's own pattern, which this file's header already claimed to
//    follow but did not implement): `stoppingId`/`bulkStopping` now gate re-entry at the top of
//    each handler, Escape is blocked on both AlertDialogContents while busy, and Cancel checks
//    the same flag before closing.
// 2. A per-row Stop re-reads the Session's LIVE status from the store at confirm time (not the
//    snapshot taken when the row's own Stop button was clicked) and refuses -- closing the
//    confirm with no IPC call -- if it is no longer idle, so a Session that started a turn while
//    the confirm was open can never be stopped out from under the idle-only rule.
// 3. The confirm title/description hold the LAST non-null target (a ref, SignOutDialog.tsx's own
//    `lastAccountRef` convention) and the bulk count is captured once when "Stop idle" opens the
//    confirm, rather than reading the live (shrinking) list -- so the text never flickers to
//    "Stop 's agent?" or "Stop 0 idle agents?" during the close animation.
// 4. Focus restore after a SUCCESSFUL stop can no longer target a button that the same stop just
//    removed from the DOM (confirmed live: the row leaves `idleSessions` the instant `status`
//    flips, before the confirm's own close animation finishes) -- `pendingFocusRef` is set, from
//    the POST-stop state, to the next remaining row's own Stop button, else the "Stop idle"
//    button (if any Sessions are still idle), else the dialog's own heading (made focusable as
//    the last resort, never left to fall to `<body>`).
// 5. Both `stopAgent` calls are wrapped in `finally`, so a rejected IPC call can never leave the
//    dialog stuck showing "Stopping…" forever (`sessions-store.ts`'s own `stopAgent` already
//    handles a `{ok:false}` result, but not a thrown/rejected `invoke`).
import { useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { useRepositoriesStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'

export interface MemoryTriageDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Returns focus to the alert row's own Triage button on close -- this dialog is opened from
   *  a plain state flag, not an AlertDialogTrigger/DialogTrigger, so Radix has no trigger ref to
   *  fall back to (same convention every other dialog in this feature folder uses). */
  onCloseFocus(): void
}

function isStillIdle(sessionId: string): boolean {
  const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId)
  return session !== undefined && session.status === 'idle' && !session.archivedAt
}

export function MemoryTriageDialog({ open, onOpenChange, onCloseFocus }: MemoryTriageDialogProps) {
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  // FR-037: idle-only, by construction -- never a Session whose agent is mid-turn ('working') or
  // waiting on the user ('needs-you'), and never one already 'stopped' (nothing to free).
  const idleSessions = sessions.filter((session) => session.status === 'idle' && !session.archivedAt)

  const [confirmTarget, setConfirmTarget] = useState<SessionSummary | null>(null)
  const lastConfirmTargetRef = useRef<SessionSummary | null>(null)
  if (confirmTarget) lastConfirmTargetRef.current = confirmTarget
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const stopButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkTargetIds, setBulkTargetIds] = useState<string[]>([])
  const [bulkStopping, setBulkStopping] = useState(false)
  const bulkButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogTitleRef = useRef<HTMLHeadingElement>(null)

  /** After a stop (single or bulk) actually settles, picks where focus goes next: the first
   *  still-idle row's own Stop button, else "Stop idle" if the list is non-empty, else the
   *  dialog's own heading -- never a button the same stop just removed. */
  function focusAfterStop(): void {
    const remaining = useSessionsStore.getState().sessions.filter((session) => session.status === 'idle' && !session.archivedAt)
    const firstRemaining = remaining[0]
    if (firstRemaining) {
      const nextButton = stopButtonRefs.current.get(firstRemaining.id)
      if (nextButton?.isConnected) {
        nextButton.focus()
        return
      }
      if (bulkButtonRef.current?.isConnected) {
        bulkButtonRef.current.focus()
        return
      }
    }
    dialogTitleRef.current?.focus()
  }

  async function handleConfirmStop(): Promise<void> {
    if (stoppingId !== null || !confirmTarget) return
    const target = confirmTarget
    if (!isStillIdle(target.id)) {
      // Gate-fix (security/architect, Medium): the Session moved on while this confirm was open
      // (started a turn, or was stopped another way) -- the idle-only rule means this confirm no
      // longer applies, so it closes without ever calling stopAgent.
      setConfirmTarget(null)
      return
    }
    setStoppingId(target.id)
    try {
      await stopAgent(target.id)
    } finally {
      setStoppingId(null)
      setConfirmTarget(null)
    }
  }

  async function handleConfirmBulkStop(): Promise<void> {
    if (bulkStopping) return
    setBulkStopping(true)
    try {
      await Promise.allSettled(bulkTargetIds.filter(isStillIdle).map((id) => stopAgent(id)))
    } finally {
      setBulkStopping(false)
      setBulkConfirmOpen(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && stoppingId === null && !bulkStopping) onOpenChange(next)
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onCloseFocus()
          }}
        >
          <DialogHeader>
            <DialogTitle ref={dialogTitleRef} tabIndex={-1}>
              Free up memory
            </DialogTitle>
            <DialogDescription>Refract never stops an agent on its own. Stop an idle agent below to free memory.</DialogDescription>
          </DialogHeader>
          {idleSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No idle agents to stop right now.</p>
          ) : (
            <>
              <div className="flex justify-end">
                <Button
                  ref={bulkButtonRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setBulkTargetIds(idleSessions.map((session) => session.id))
                    setBulkConfirmOpen(true)
                  }}
                >
                  Stop idle
                </Button>
              </div>
              <ul className="flex flex-col gap-1">
                {idleSessions.map((session) => {
                  const repository = repositoriesById.get(session.repositoryId)
                  return (
                    <li key={session.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{session.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {repository?.name ?? 'Unknown repository'} &middot; Idle {formatRelativeTime(session.lastActivityAt)}
                        </p>
                      </div>
                      <Button
                        ref={(el) => {
                          if (el) stopButtonRefs.current.set(session.id, el)
                          else stopButtonRefs.current.delete(session.id)
                        }}
                        type="button"
                        variant="outline"
                        size="xs"
                        aria-disabled={stoppingId === session.id || undefined}
                        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        onClick={() => {
                          if (stoppingId !== null) return
                          setConfirmTarget(session)
                        }}
                      >
                        {stoppingId === session.id ? 'Stopping…' : 'Stop'}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next && stoppingId === null) setConfirmTarget(null)
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (stoppingId !== null) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = stopButtonRefs.current.get(lastConfirmTargetRef.current?.id ?? '')
            if (target?.isConnected) target.focus()
            else focusAfterStop()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {lastConfirmTargetRef.current?.name}'s agent?</AlertDialogTitle>
            <AlertDialogDescription>
              {lastConfirmTargetRef.current?.name} stays listed; reopening it resumes where it left off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              aria-disabled={stoppingId !== null}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                if (stoppingId !== null) {
                  event.preventDefault()
                  return
                }
                setConfirmTarget(null)
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              aria-disabled={stoppingId !== null}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmStop()
              }}
            >
              {stoppingId !== null ? 'Stopping…' : 'Stop'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={bulkConfirmOpen}
        onOpenChange={(next) => {
          if (!next && !bulkStopping) setBulkConfirmOpen(false)
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (bulkStopping) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (bulkButtonRef.current?.isConnected) bulkButtonRef.current.focus()
            else focusAfterStop()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {bulkTargetIds.length} idle agent{bulkTargetIds.length === 1 ? '' : 's'}?</AlertDialogTitle>
            <AlertDialogDescription>Every one stays listed; reopening any of them resumes where it left off.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              aria-disabled={bulkStopping}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                if (bulkStopping) {
                  event.preventDefault()
                  return
                }
                setBulkConfirmOpen(false)
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              aria-disabled={bulkStopping}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmBulkStop()
              }}
            >
              {bulkStopping ? 'Stopping…' : 'Stop idle'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
