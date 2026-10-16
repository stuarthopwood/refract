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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

export function MemoryTriageDialog({ open, onOpenChange, onCloseFocus }: MemoryTriageDialogProps) {
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  // FR-037: idle-only, by construction -- never a Session whose agent is mid-turn ('working') or
  // waiting on the user ('needs-you'), and never one already 'stopped' (nothing to free).
  const idleSessions = sessions.filter((session) => session.status === 'idle' && !session.archivedAt)

  const [confirmTarget, setConfirmTarget] = useState<SessionSummary | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const lastStopButtonRef = useRef<HTMLButtonElement | null>(null)

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkStopping, setBulkStopping] = useState(false)
  const bulkButtonRef = useRef<HTMLButtonElement | null>(null)

  async function handleConfirmStop(): Promise<void> {
    if (!confirmTarget) return
    setStoppingId(confirmTarget.id)
    await stopAgent(confirmTarget.id)
    setStoppingId(null)
    setConfirmTarget(null)
  }

  async function handleConfirmBulkStop(): Promise<void> {
    setBulkStopping(true)
    await Promise.all(idleSessions.map((session) => stopAgent(session.id)))
    setBulkStopping(false)
    setBulkConfirmOpen(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onCloseFocus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Free up memory</DialogTitle>
            <DialogDescription>Refract never stops an agent on its own. Stop an idle agent below to free memory.</DialogDescription>
          </DialogHeader>
          {idleSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No idle agents to stop right now.</p>
          ) : (
            <>
              <div className="flex justify-end">
                <Button ref={bulkButtonRef} type="button" variant="outline" size="sm" onClick={() => setBulkConfirmOpen(true)}>
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
                        type="button"
                        variant="outline"
                        size="xs"
                        aria-disabled={stoppingId === session.id || undefined}
                        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        onClick={(event) => {
                          lastStopButtonRef.current = event.currentTarget
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
          <DialogFooter />
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmTarget !== null} onOpenChange={(next) => { if (!next) setConfirmTarget(null) }}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            lastStopButtonRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {confirmTarget?.name}'s agent?</AlertDialogTitle>
            <AlertDialogDescription>{confirmTarget?.name} stays listed; reopening it resumes where it left off.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel aria-disabled={stoppingId !== null} className="aria-disabled:pointer-events-none aria-disabled:opacity-50">
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

      <AlertDialog open={bulkConfirmOpen} onOpenChange={(next) => { if (!next) setBulkConfirmOpen(false) }}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            bulkButtonRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {idleSessions.length} idle agents?</AlertDialogTitle>
            <AlertDialogDescription>Every one stays listed; reopening any of them resumes where it left off.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel aria-disabled={bulkStopping} className="aria-disabled:pointer-events-none aria-disabled:opacity-50">
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
              {bulkStopping ? 'Stopping…' : 'Stop all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
