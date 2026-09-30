// Delete confirmation (FR-029, T042; contracts/ipc.md `sessions.deleteCheck`/`sessions.delete`):
// names exactly what a delete loses before it happens. Shared by the SessionList row menu and
// the ChatPane worktree-missing banner (FR-035), so it takes only the id/name it needs, not a
// full SessionSummary.
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

interface DeleteCheck {
  uncommittedFiles: number
  unpushedCommits: number
  hasUpstream: boolean
}

export interface DeleteDialogProps {
  session: { id: string; name: string }
  open: boolean
  onOpenChange(open: boolean): void
  /** Overrides the `sessions.deleteCheck` call with a fixed result. Used only to render this
   * dialog in isolation for verification screenshots, without a running main process; harmless
   * in normal use, where every real caller leaves it unset and the dialog always calls
   * `deleteCheck`. */
  check?: DeleteCheck
  /** Called after the dialog finishes closing (its close-autofocus), so the caller can move
   * focus off the row it's about to unmount (WCAG 2.1 AA focus-visibility) without Radix's
   * own return-to-trigger focus restoration overriding it. */
  onDeleted?(): void
}

export function DeleteDialog({ session, open, onOpenChange, check, onDeleted }: DeleteDialogProps) {

  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<DeleteCheck | null>(check ?? null)
  const [error, setError] = useState<string | null>(null)
  const deletedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (check) {
      setResult(check)
      return
    }
    setResult(null)
    setLoading(true)
    let cancelled = false
    void window.pinion.sessions.deleteCheck(session.id).then((response) => {
      if (cancelled) return
      setLoading(false)
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setResult(response.value)
    })
    return () => {
      cancelled = true
    }
  }, [open, session.id, check])

  async function handleDelete(): Promise<void> {
    setDeleting(true)
    setError(null)
    const response = await window.pinion.sessions.delete(session.id, { confirmed: true })
    setDeleting(false)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    deletedRef.current = true
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (deletedRef.current) {
            event.preventDefault()
            deletedRef.current = false
            onDeleted?.()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Session {session.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes its worktree, its branch, and its Conversations.</AlertDialogDescription>
        </AlertDialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Checking for uncommitted or unpushed work…</p>}
        {result && (result.uncommittedFiles > 0 || result.unpushedCommits > 0 || !result.hasUpstream) && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {result.uncommittedFiles > 0 && (
              <li>
                {result.uncommittedFiles} uncommitted file{result.uncommittedFiles === 1 ? '' : 's'} will be lost
              </li>
            )}
            {result.unpushedCommits > 0 && (
              <li>
                {result.unpushedCommits} commit{result.unpushedCommits === 1 ? '' : 's'} not pushed will be lost
              </li>
            )}
            {!result.hasUpstream && <li>This branch has no upstream</li>}
          </ul>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={loading || deleting}
            onClick={(event) => {
              event.preventDefault()
              void handleDelete()
            }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
