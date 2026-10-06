// Remove-repository confirmation (FR-059, Clarifications 2026-10-06, T108; contracts/ipc.md
// `repositories.remove`): names exactly what removal does before it happens, and refuses
// outright while the Repository still owns any Session (active or archived) -- counts come
// straight from `useSessionsStore`, never a separate fetch, so they can never disagree with
// what the session list itself is showing. Built on `AlertDialog` like `DeleteDialog.tsx`.
import { useEffect, useRef, useState } from 'react'
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
import { useRepositoriesStore, useSessionsStore } from '@/state'

export interface RemoveRepositoryDialogProps {
  repository: { id: string; name: string }
  open: boolean
  onOpenChange(open: boolean): void
  /** Called after a successful removal, once the dialog finishes closing (WCAG 2.1 AA
   * focus-visibility): the caller moves focus to another repository's header, or to the
   * first-run readiness screen once none remain. */
  onRemoved?(): void
  /** Called after the dialog finishes closing without removing anything (Close on the blocked
   * state, Cancel, Escape, or Cancel-after-error). Neither caller renders an
   * `AlertDialogTrigger` (both open via `open={removeOpen}`), so Radix's own close-autofocus has
   * nothing to return to and would otherwise drop focus to `<body>`. */
  onCancelled?(): void
}

function describeOwnedSessions(activeCount: number, archivedCount: number): string {
  const parts: string[] = []
  if (activeCount > 0) parts.push(`${activeCount} active Session${activeCount === 1 ? '' : 's'}`)
  if (archivedCount > 0) parts.push(`${archivedCount} archived Session${archivedCount === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

export function RemoveRepositoryDialog({ repository, open, onOpenChange, onRemoved, onCancelled }: RemoveRepositoryDialogProps) {
  const sessions = useSessionsStore((state) => state.sessions)
  const remove = useRepositoriesStore((state) => state.remove)
  // Mirrors RepositoryGroup's own `creatingRef`/`creating` pair: the ref blocks a second submit
  // before React re-renders (a double-click or double-Enter), the state drives aria-disabled and
  // the button's label.
  const removingRef = useRef(false)
  const [removing, setRemoving] = useState(false)
  const removedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    removingRef.current = false
    removedRef.current = false
    setRemoving(false)
  }, [open])

  const activeCount = sessions.filter((session) => session.repositoryId === repository.id && !session.archivedAt).length
  const archivedCount = sessions.filter((session) => session.repositoryId === repository.id && session.archivedAt).length
  const blocked = activeCount + archivedCount > 0

  async function handleRemove(): Promise<void> {
    if (removingRef.current) return
    removingRef.current = true
    setRemoving(true)
    const ok = await remove(repository.id)
    removingRef.current = false
    setRemoving(false)
    // A failure already surfaced through `notify` inside the store; nothing else changed, so the
    // dialog just stays open exactly as it was.
    if (!ok) return
    removedRef.current = true
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (removedRef.current) {
            removedRef.current = false
            onRemoved?.()
          } else {
            onCancelled?.()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (removing) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{blocked ? `Can't remove ${repository.name} yet` : `Remove ${repository.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `${repository.name} still owns ${describeOwnedSessions(activeCount, archivedCount)}. Delete ${
                  activeCount + archivedCount === 1 ? 'it' : 'them'
                } first, then remove this repository.`
              : "This removes only Refract's entry for this repository. The folder on disk is untouched."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {blocked ? (
            <AlertDialogCancel>Close</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel
                aria-disabled={removing}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={(event) => {
                  if (removing) event.preventDefault()
                }}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                aria-disabled={removing}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={(event) => {
                  event.preventDefault()
                  if (removing) return
                  void handleRemove()
                }}
              >
                {removing ? 'Removing…' : 'Remove'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
