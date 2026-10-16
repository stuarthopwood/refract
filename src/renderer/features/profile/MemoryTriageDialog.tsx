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
// Quality-gate remediation (round 1, four reviewers): five separate issues, all fixed here
// together since they all touch the same two confirm flows.
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
//    removed from the DOM (the row leaves `idleSessions` the instant `status` flips, before the
//    confirm's own close animation finishes) -- `pendingFocusRef` is set, from the POST-stop
//    state, to the next remaining row's own Stop button, else the "Stop idle" button (if any
//    Sessions are still idle), else the dialog's own heading (made focusable as the last resort,
//    never left to fall to `<body>`).
// 5. Both `stopAgent` calls are wrapped in `finally`, so a rejected IPC call can never leave the
//    dialog stuck showing "Stopping…" forever (`sessions-store.ts`'s own `stopAgent` already
//    handles a `{ok:false}` result itself by calling `notify`, but not a thrown/rejected
//    `invoke` -- that case is now also caught here, below).
//
// Quality-gate remediation (round 2, five-reviewer gate on PR #945): the last CLEAN live-CDP run
// of this flow was at commit cd4b0e3, against an earlier version of this script -- the round-1
// (f3014ae) and round-2 (this commit's own) code fixes below are NOT YET verified live, pending
// a fresh chained build+run once a build slot is available.
// 6. A thrown/rejected `stopAgent` now surfaces via `notify()` (single: one failure; bulk: one
//    notification naming the failure count, not once per Session), and a successful stop is
//    announced via `useChatAreaAnnouncer` ("Stopped {name}'s agent" / "Stopped {N} agents"); the
//    idle-moved-on skip (`isStillIdle` above) now announces instead of silently closing.
// 7. `stoppedIdsRef` tracks Session ids whose stop is currently in flight (added right before
//    each `stopAgent` call, single and bulk alike) and excludes them from `focusAfterStop()`'s
//    own candidate search -- `idleSessions` is re-read live there, which could otherwise still
//    include an id whose OWN stop is in flight from a different, concurrent call. A
//    `useLayoutEffect` backstop also watches the live idle list and redirects focus into the
//    dialog whenever `document.activeElement` is disconnected or literally `<body>`.
// 8. Per-row Stop buttons carry an explicit `aria-label="Stop {name}'s agent"` (the visible text
//    alone, "Stop"/"Stopping…", does not distinguish rows for a screen reader); every Stop
//    confirmation action (`AlertDialogAction`, single and bulk) uses `variant="invert"`, never
//    `"destructive"` -- `button.tsx`'s own comment on that variant (decision 5, issue #564)
//    already establishes that stopping is never destructive-red (it keeps the work, the opposite
//    of irreversible), the same reasoning FR-037 itself only ever requires a CONFIRMATION, never
//    a colour.
// 9. Layout (ui-architect-v3 consensus): "Stop idle" moved out of its own `flex justify-end` row
//    into the `DialogFooter`, beside a new `Done` button that takes initial focus on open
//    (`HealthCheckDialog.tsx`'s own `doneRef`/`onOpenAutoFocus` convention). The Session list
//    scrolls past a capped height instead of growing the dialog unbounded. The bulk confirm's own
//    description now NAMES the Sessions being stopped, not just the count (the same spirit
//    FR-037 already requires for the single-stop case).
// 10. The two near-identical confirm flows (title/description/busy Cancel-destructive-Action
//     footer/`onCloseAutoFocus`) are now one shared `ConfirmStopAlertDialog`, parameterised by
//     title/description/busy/onConfirm/onCloseAutoFocus.
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
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
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { isFocusStranded } from '@/lib/focus'
import { notify, useRepositoriesStore, useSessionsStore } from '@/state'
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

/** Shared by the per-row and bulk confirm flows (quality-gate remediation, round 2, item 13):
 *  they differ only in title/description/busy/onConfirm. */
function ConfirmStopAlertDialog({
  open,
  busy,
  title,
  description,
  onCancel,
  onConfirm,
  onCloseAutoFocus
}: {
  open: boolean
  busy: boolean
  title: ReactNode
  description: ReactNode
  onCancel(): void
  onConfirm(): void
  onCloseAutoFocus(): void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseAutoFocus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              if (busy) {
                event.preventDefault()
                return
              }
              onCancel()
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="invert"
            aria-disabled={busy}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {busy ? 'Stopping…' : 'Stop'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
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
  // Item 8 (gate round 2): ids whose stop is currently in flight, single OR bulk -- excluded
  // from `focusAfterStop()`'s own candidate search, which otherwise re-reads the live
  // (possibly still-idle-for-a-moment) `idleSessions` list and could land on a Stop button for
  // a Session a DIFFERENT, concurrent stop call is already mid-flight for.
  const stoppedIdsRef = useRef(new Set<string>())

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkTargetIds, setBulkTargetIds] = useState<string[]>([])
  const [bulkTargetNames, setBulkTargetNames] = useState<string[]>([])
  const [bulkStopping, setBulkStopping] = useState(false)
  const bulkButtonRef = useRef<HTMLButtonElement | null>(null)
  const doneButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogTitleRef = useRef<HTMLHeadingElement>(null)

  /** After a stop (single or bulk) actually settles, picks where focus goes next: the first
   *  still-idle row's own Stop button (excluding any OTHER stop still in flight), else "Stop
   *  idle" if the list is non-empty, else the dialog's own heading -- never a button the same
   *  stop just removed. */
  function focusAfterStop(): void {
    const remaining = useSessionsStore
      .getState()
      .sessions.filter((session) => session.status === 'idle' && !session.archivedAt && !stoppedIdsRef.current.has(session.id))
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

  // Item 8 (gate round 2): a backstop beyond the explicit `onCloseAutoFocus` paths -- whenever
  // the live idle list changes AND focus is stranded (disconnected, or dropped to `<body>`),
  // redirects focus back into the dialog rather than leaving it on nothing.
  useLayoutEffect(() => {
    if (!open) return
    if (isFocusStranded(document.activeElement, null)) focusAfterStop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idleSessions.length])

  async function handleConfirmStop(): Promise<void> {
    if (stoppingId !== null || !confirmTarget) return
    const target = confirmTarget
    if (!isStillIdle(target.id)) {
      // Gate-fix (security/architect, Medium): the Session moved on while this confirm was open
      // (started a turn, or was stopped another way) -- the idle-only rule means this confirm no
      // longer applies, so it closes without ever calling stopAgent.
      setConfirmTarget(null)
      useChatAreaAnnouncer.getState().announce(`${target.name} is no longer idle; nothing stopped`)
      return
    }
    setStoppingId(target.id)
    stoppedIdsRef.current.add(target.id)
    try {
      await stopAgent(target.id)
      useChatAreaAnnouncer.getState().announce(`Stopped ${target.name}'s agent`)
    } catch {
      notify({ code: 'agent-not-running', message: `Couldn't stop ${target.name}'s agent. Try again.` })
    } finally {
      stoppedIdsRef.current.delete(target.id)
      setStoppingId(null)
      setConfirmTarget(null)
    }
  }

  async function handleConfirmBulkStop(): Promise<void> {
    if (bulkStopping) return
    setBulkStopping(true)
    const targets = bulkTargetIds.filter(isStillIdle)
    targets.forEach((id) => stoppedIdsRef.current.add(id))
    try {
      const results = await Promise.allSettled(targets.map((id) => stopAgent(id)))
      const failureCount = results.filter((result) => result.status === 'rejected').length
      const successCount = results.length - failureCount
      if (failureCount > 0) {
        notify({
          code: 'agent-not-running',
          message: `Couldn't stop ${failureCount} agent${failureCount === 1 ? '' : 's'}. Try again.`
        })
      }
      if (successCount > 0) useChatAreaAnnouncer.getState().announce(`Stopped ${successCount} agent${successCount === 1 ? '' : 's'}`)
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
            <DialogDescription>Refract never stops an agent on its own. Stop an idle agent below to free memory.</DialogDescription>
          </DialogHeader>
          {idleSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No idle agents to stop right now.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
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
                      aria-label={`Stop ${session.name}'s agent`}
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
          )}
          <DialogFooter>
            {idleSessions.length > 0 && (
              <Button
                ref={bulkButtonRef}
                type="button"
                variant="outline"
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
            <Button ref={doneButtonRef} type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
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
        title={`Stop ${bulkTargetIds.length} idle agent${bulkTargetIds.length === 1 ? '' : 's'}?`}
        description={`${bulkTargetNames.join(', ')} ${bulkTargetNames.length === 1 ? 'stays' : 'stay'} listed; reopening any of them resumes where it left off.`}
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
