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

/** Props for {@link RemoveRepositoryDialog}. */
export interface RemoveRepositoryDialogProps {
  repository: { id: string; name: string }
  open: boolean
  onOpenChange(open: boolean): void
  onRemoved?(preferredRepositoryId?: string): void
  onCancelled?(): void
}

function describeOwnedSessions(activeCount: number, archivedCount: number): string {
  const parts: string[] = []
  if (activeCount > 0) parts.push(`${activeCount} active Session${activeCount === 1 ? '' : 's'}`)
  if (archivedCount > 0) parts.push(`${archivedCount} archived Session${archivedCount === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

function findAdjacentRepositoryId(repositoryId: string): string | undefined {
  const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-repository-id]'))
  const index = groups.findIndex((group) => group.getAttribute('data-repository-id') === repositoryId)
  if (index === -1) return undefined
  return groups[index + 1]?.getAttribute('data-repository-id') ?? groups[index - 1]?.getAttribute('data-repository-id') ?? undefined
}

/** Confirmation dialog for removing a repository. */
export function RemoveRepositoryDialog({ repository, open, onOpenChange, onRemoved, onCancelled }: RemoveRepositoryDialogProps) {
  const sessions = useSessionsStore((state) => state.sessions)
  const remove = useRepositoriesStore((state) => state.remove)
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
      if (!ok) return
      removedRef.current = true
      window.setTimeout(() => onRemoved?.(preferredRepositoryId), 0)
    } catch {
      toast.error('Could not remove the project. Try again.')
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
                } first, then remove this project.`
              : "This removes only Refract's entry for this project. The folder on disk is untouched."}
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
