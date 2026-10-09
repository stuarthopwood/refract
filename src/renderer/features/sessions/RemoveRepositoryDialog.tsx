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
import { toast } from 'sonner'
import { useRepositoriesStore, useSessionsStore } from '@/state'

export interface RemoveRepositoryDialogProps {
  repository: { id: string; name: string }
  open: boolean
  onOpenChange(open: boolean): void
  /** Called via `window.setTimeout(…, 0)` right after a successful removal. `remove()` unmounts
   * the whole repository group -- this dialog included -- synchronously as part of that same
   * store update, so this can never wait for Radix's own close-autofocus to run; the timeout only
   * waits for React to commit that unmount (WCAG 2.1 AA focus-visibility). The caller moves focus
   * to the repository group that was adjacent to the removed one when a `preferredRepositoryId`
   * is given and still mounted, otherwise the first remaining group's header, or the first-run
   * readiness screen once none remain. */
  onRemoved?(preferredRepositoryId?: string): void
  /** Called after the dialog finishes closing without removing anything (Close on the blocked
   * state, Cancel, Escape, or Cancel-after-error) -- the only path left into `onCloseAutoFocus`
   * once a successful removal no longer runs through it. Neither caller renders an
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

// Captures the next remaining repository group (or the previous one if the removed group was
// last) before `remove()` runs and unmounts it, so `onRemoved` can send focus there once React
// commits -- the DOM order this reads is still the pre-removal order.
function findAdjacentRepositoryId(repositoryId: string): string | undefined {
  const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-repository-id]'))
  const index = groups.findIndex((group) => group.getAttribute('data-repository-id') === repositoryId)
  if (index === -1) return undefined
  return groups[index + 1]?.getAttribute('data-repository-id') ?? groups[index - 1]?.getAttribute('data-repository-id') ?? undefined
}

export function RemoveRepositoryDialog({ repository, open, onOpenChange, onRemoved, onCancelled }: RemoveRepositoryDialogProps) {
  const sessions = useSessionsStore((state) => state.sessions)
  const remove = useRepositoriesStore((state) => state.remove)
  // The same local double-submit guard `sessions-store.ts`'s `creatingRepositoryIds` now covers
  // for Session creation (issue #620): the ref blocks a second submit before React re-renders (a
  // double-click or double-Enter), the state drives aria-disabled and the button's label.
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
    const preferredRepositoryId = findAdjacentRepositoryId(repository.id)
    try {
      const ok = await remove(repository.id)
      // A failure already surfaced through `notify` inside the store; nothing else changed, so
      // the dialog just stays open exactly as it was. A thrown error is treated the same way --
      // not removed.
      if (!ok) return
      removedRef.current = true
      // `remove()` unmounts this whole repository group -- this dialog included -- synchronously
      // as part of the store update above, so there is no "after the dialog finishes closing"
      // moment left to hook here; 0ms (not requestAnimationFrame, which is throttled while the
      // verification window is hidden) is just long enough for React to commit that unmount.
      window.setTimeout(() => onRemoved?.(preferredRepositoryId), 0)
    } catch {
      toast.error('Could not remove the repository. Try again.')
    } finally {
      removingRef.current = false
      setRemoving(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        aria-busy={removing}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // A successful removal already scheduled `onRemoved` itself above; this only ever runs
          // for Close/Cancel/Escape, where nothing was removed.
          if (!removedRef.current) onCancelled?.()
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
