// Delete confirmation (FR-029, T042; contracts/ipc.md `sessions.deleteCheck`/`sessions.delete`):
// names exactly what a delete loses before it happens. Shared by the SessionList row menu and
// the ChatPane worktree-missing banner (FR-035), so it takes only the id/name it needs, not a
// full SessionSummary.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
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
  onDeleted?(): void
  /** Called after the dialog finishes closing without deleting (Cancel, Escape, or
   * Cancel-after-error), so the caller can move focus off whatever element the dialog is about
   * to leave behind (WCAG 2.1 AA focus-visibility). Radix's own close-autofocus would normally
   * return focus to the AlertDialogTrigger, but neither caller renders one (both open via
   * `open={deleteOpen}`), so its `triggerRef` is always null and focus would otherwise fall to
   * `<body>`. */
  onCancelled?(): void
}
export function DeleteDialog({ session, open, onOpenChange, check, onDeleted, onCancelled }: DeleteDialogProps) {

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
          event.preventDefault()
          if (deletedRef.current) {
            deletedRef.current = false
            onDeleted?.()
          } else {
            onCancelled?.()
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
        <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
          {error ?? ''}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel aria-disabled={deleting} className="aria-disabled:pointer-events-none aria-disabled:opacity-50">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            aria-disabled={loading || deleting}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              event.preventDefault()
              if (loading || deleting) return
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
