// The low-memory alert's "Triage" dialog (#560): idle, unpaused Sessions only, each with a confirmed Stop,
// plus "Stop idle". Confirms use local state so focus can return to the opening button.
// Invariants: handlers guard re-entry and re-read live status at confirm time; confirm text keeps
// the last target through the close animation; Stop uses `variant="invert"` (#564); announce()
// fires once per action, since a second call in the same tick cancels the first.
import { useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, RefObject } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { isFocusStranded } from '@/lib/focus'
import { notify, useRepositoriesStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import { countPausedIdle, isIdleStoppable } from './triageSessions'

export interface MemoryTriageDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Returns focus to the Triage button on close; the dialog opens from a state flag, so Radix has no trigger ref. */
  onCloseFocus(): void
}

function isStillIdle(sessionId: string): boolean {
  const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId)
  return session !== undefined && isIdleStoppable(session)
}

/** Shared confirm for the per-row and bulk flows, which differ only in title/description/busy/onConfirm. */
function ConfirmStopAlertDialog(props: Omit<ComponentProps<typeof ConfirmAlertDialog>, 'confirmLabel' | 'busyLabel'>) {
  return <ConfirmAlertDialog {...props} confirmLabel="Stop" busyLabel="Stopping…" />
}

export function MemoryTriageDialog({ open, onOpenChange, onCloseFocus }: MemoryTriageDialogProps) {
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  // FR-037: idle-only; never a working, needs-you, stopped or paused Session.
  const idleSessions = sessions.filter(isIdleStoppable)
  const pausedSkipped = countPausedIdle(sessions)

  const [confirmTarget, setConfirmTarget] = useState<SessionSummary | null>(null)
  const lastConfirmTargetRef = useRef<SessionSummary | null>(null)
  if (confirmTarget) lastConfirmTargetRef.current = confirmTarget
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const stopButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  // Ids with a stop in flight (single or bulk); excluded from the focus-after-stop candidates.
  const stoppedIdsRef = useRef(new Set<string>())

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkTargetIds, setBulkTargetIds] = useState<string[]>([])
  const [bulkTargetNames, setBulkTargetNames] = useState<string[]>([])
  const [bulkStopping, setBulkStopping] = useState(false)
  const bulkButtonRef = useRef<HTMLButtonElement | null>(null)
  const doneButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogTitleRef = useRef<HTMLHeadingElement>(null)

  /** Picks the next focus target after a stop: next idle row's Stop, else "Stop idle", else Done, else the heading. */
  function focusAfterStop(): void {
    const remaining = useSessionsStore
      .getState()
      .sessions.filter((session) => isIdleStoppable(session) && !stoppedIdsRef.current.has(session.id))
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
    if (doneButtonRef.current?.isConnected) {
      doneButtonRef.current.focus()
      return
    }
    dialogTitleRef.current?.focus()
  }

  // Backstop: redirect focus into the dialog if the idle list changes and focus is stranded.
  useLayoutEffect(() => {
    if (!open) return
    if (isFocusStranded(document.activeElement, null)) focusAfterStop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idleSessions.length])

  async function handleConfirmStop(): Promise<void> {
    if (stoppingId !== null || !confirmTarget) return
    const target = confirmTarget
    if (!isStillIdle(target.id)) {
      // The Session moved on while the confirm was open; close without calling stopAgent.
      setConfirmTarget(null)
      useChatAreaAnnouncer.getState().announce(`${target.name} is no longer idle; nothing stopped`)
      return
    }
    setStoppingId(target.id)
    stoppedIdsRef.current.add(target.id)
    try {
      const ok = await stopAgent(target.id)
      // A clean {ok:false} is already toasted by the store; only the thrown branch below needs its own.
      useChatAreaAnnouncer.getState().announce(ok ? `Stopped ${target.name}'s agent` : `Couldn't stop ${target.name}'s agent`)
    } catch {
      notify({ code: 'agent-not-running', message: `Couldn't stop ${target.name}'s agent. Try again.` })
      useChatAreaAnnouncer.getState().announce(`Couldn't stop ${target.name}'s agent`)
    } finally {
      stoppedIdsRef.current.delete(target.id)
      setStoppingId(null)
      setConfirmTarget(null)
    }
  }

  async function handleConfirmBulkStop(): Promise<void> {
    if (bulkStopping) return
    setBulkStopping(true)
    // Built before filtering below, since `targets` can drop ids `isStillIdle` excludes --
    // the name lookup still needs to work for every id this bulk action was opened with.
    const idToName = new Map(bulkTargetIds.map((id, index) => [id, bulkTargetNames[index]]))
    const targets = bulkTargetIds.filter(isStillIdle)
    if (targets.length === 0) {
      // Every target moved on while the confirm was open; announce instead of closing silently.
      useChatAreaAnnouncer.getState().announce(`${bulkTargetIds.length} no longer idle; not stopped`)
      setBulkStopping(false)
      setBulkConfirmOpen(false)
      return
    }
    targets.forEach((id) => stoppedIdsRef.current.add(id))
    try {
      // `thrown` marks a rejected call, the only case this dialog toasts; a clean {ok:false} is
      // already toasted by the store. The announcement below still names every failure.
      const outcomes = await Promise.all(
        targets.map(async (id) => {
          try {
            return { id, ok: await stopAgent(id), thrown: false }
          } catch {
            return { id, ok: false, thrown: true }
          }
        })
      )
      const failed = outcomes.filter((outcome) => !outcome.ok)
      const failedNames = failed.map((outcome) => idToName.get(outcome.id) ?? outcome.id)
      const thrownNames = failed.filter((outcome) => outcome.thrown).map((outcome) => idToName.get(outcome.id) ?? outcome.id)
      const successCount = outcomes.length - failed.length
      if (thrownNames.length > 0) {
        notify({
          code: 'agent-not-running',
          message:
            thrownNames.length === 1
              ? `Couldn't stop ${thrownNames[0]}'s agent. Try again.`
              : `Couldn't stop ${thrownNames.length} agents: ${thrownNames.join(', ')}. Try again.`
        })
      }
      // One joined announce(): a second call in the same tick cancels the first.
      const parts: string[] = []
      if (successCount > 0) parts.push(`Stopped ${successCount} agent${successCount === 1 ? '' : 's'}`)
      if (failedNames.length > 0) {
        parts.push(
          failedNames.length === 1
            ? `Couldn't stop ${failedNames[0]}'s agent`
            : `Couldn't stop ${failedNames.length} agents: ${failedNames.join(', ')}`
        )
      }
      if (parts.length > 0) useChatAreaAnnouncer.getState().announce(parts.join('. '))
    } finally {
      targets.forEach((id) => stoppedIdsRef.current.delete(id))
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
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            doneButtonRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onCloseFocus()
          }}
        >
          <DialogHeader>
            <DialogTitle ref={dialogTitleRef} tabIndex={-1}>
              Free up memory
            </DialogTitle>
            <DialogDescription>
              {idleSessions.length > 0
                ? `${idleSessions.length} idle agent${idleSessions.length === 1 ? '' : 's'} using memory. Refract never stops one on its own. Stop one below to free it.`
                : 'Refract never stops an agent on its own.'}
            </DialogDescription>
          </DialogHeader>
          {idleSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No idle agents to stop right now.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {idleSessions.map((session) => {
                const repository = repositoriesById.get(session.repositoryId)
                return (
                  <li key={session.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{session.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {repository?.name ?? 'Unknown project'} &middot; Idle {formatRelativeTime(session.lastActivityAt)}
                      </p>
                    </div>
                    <Button
                      ref={(el) => {
                        if (el) stopButtonRefs.current.set(session.id, el)
                        else stopButtonRefs.current.delete(session.id)
                      }}
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={`Stop ${session.name}'s agent`}
                      aria-disabled={stoppingId === session.id || undefined}
                      className="aria-disabled:opacity-50"
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
          )}
          {pausedSkipped > 0 && (
            <p className="text-sm text-muted-foreground">
              Skipped {pausedSkipped} paused {pausedSkipped === 1 ? 'Session' : 'Sessions'}.
            </p>
          )}
          <DialogFooter>
            {idleSessions.length > 0 && (
              <Button
                ref={bulkButtonRef}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBulkTargetIds(idleSessions.map((session) => session.id))
                  setBulkTargetNames(idleSessions.map((session) => session.name))
                  setBulkConfirmOpen(true)
                }}
              >
                Stop idle
              </Button>
            )}
            <Button ref={doneButtonRef} type="button" size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmStopAlertDialog
        open={confirmTarget !== null}
        busy={stoppingId !== null}
        title={`Stop ${lastConfirmTargetRef.current?.name}'s agent?`}
        description={`${lastConfirmTargetRef.current?.name} stays listed; reopening it resumes where it left off.`}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => void handleConfirmStop()}
        onCloseAutoFocus={() => {
          const target = stopButtonRefs.current.get(lastConfirmTargetRef.current?.id ?? '')
          if (target?.isConnected) target.focus()
          else focusAfterStop()
        }}
      />

      <ConfirmStopAlertDialog
        open={bulkConfirmOpen}
        busy={bulkStopping}
        title={
          bulkTargetIds.length === 1 ? `Stop ${bulkTargetNames[0]}'s agent?` : `Stop ${bulkTargetIds.length} idle agents?`
        }
        description={
          bulkTargetIds.length === 1
            ? `${bulkTargetNames[0]} stays listed; reopening it resumes where it left off.`
            : `${bulkTargetNames.join(', ')} stay listed; reopening any of them resumes where it left off.`
        }
        onCancel={() => setBulkConfirmOpen(false)}
        onConfirm={() => void handleConfirmBulkStop()}
        onCloseAutoFocus={() => {
          if (bulkButtonRef.current?.isConnected) bulkButtonRef.current.focus()
          else focusAfterStop()
        }}
      />
    </>
  )
}
