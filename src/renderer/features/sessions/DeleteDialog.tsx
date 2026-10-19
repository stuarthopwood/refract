// Delete confirmation (FR-029, T042; contracts/ipc.md `sessions.deleteCheck`/`sessions.delete`):
// names exactly what a delete loses before it happens. Shared by the SessionList row menu and
// the ChatPane worktree-missing banner (FR-035), so it takes only the id/name it needs, not a
// full SessionSummary.
import { useEffect, useRef, useState } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
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

interface LeftoverSummary {
  generatedFolders: { name: string; fileCount: number }[]
  otherFiles: string[]
  moreCount: number
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
  /** Overrides the `sessions.deleteLeftoverSummary` call with a fixed result. Used only to
   * render this dialog in isolation for verification screenshots, without a running main
   * process; harmless in normal use, where every real caller leaves it unset and the dialog
   * always calls `deleteLeftoverSummary`. */
  leftoverSummary?: LeftoverSummary
  onDeleted?(): void
  /** Called after the dialog finishes closing without deleting (Cancel, Escape, or
   * Cancel-after-error), so the caller can move focus off whatever element the dialog is about
   * to leave behind (WCAG 2.1 AA focus-visibility). Radix's own close-autofocus would normally
   * return focus to the AlertDialogTrigger, but neither caller renders one (both open via
   * `open={deleteOpen}`), so its `triggerRef` is always null and focus would otherwise fall to
   * `<body>`. */
  onCancelled?(): void
}
export function DeleteDialog({
  session,
  open,
  onOpenChange,
  check,
  leftoverSummary: leftoverSummaryOverride,
  onDeleted,
  onCancelled
}: DeleteDialogProps) {

  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<DeleteCheck | null>(check ?? null)
  const [leftoverLoading, setLeftoverLoading] = useState(false)
  const [leftoverSummary, setLeftoverSummary] = useState<LeftoverSummary | null>(leftoverSummaryOverride ?? null)
  const [error, setError] = useState<string | null>(null)
  const deletedRef = useRef(false)
  // Live, not closure-captured: handleDelete's own `session` is fixed to whatever it was
  // when that specific call started (an ordinary JS closure), so it can never detect that a
  // DIFFERENT Session's dialog is now showing by the time its await resolves. This ref is
  // reassigned every render, so it always reflects whichever Session is current *right now*.
  const sessionIdRef = useRef(session.id)
  sessionIdRef.current = session.id

  useEffect(() => {
    if (!open) return
    // Round 4 fix (real bug found by review after the deleteForId refactor landed): this
    // instance now persists across a Session change instead of remounting, so a stale
    // deletedRef/deleting from a PREVIOUS Session's delete must never leak into a dialog
    // freshly opened for a DIFFERENT Session.
    deletedRef.current = false
    setDeleting(false)
    setError(null)
    let cancelled = false

    if (check) {
      setResult(check)
    } else {
      setResult(null)
      setLoading(true)
      void window.refract.sessions.deleteCheck(session.id).then((response) => {
        if (cancelled) return
        setLoading(false)
        if (!response.ok) {
          setError(response.error.message)
          return
        }
        setResult(response.value)
      })
    }

    // Issue #891: a SEPARATE background walk from `deleteCheck` above -- it can take real time
    // against a large worktree, never gates Delete, and a failure here is purely informational
    // (never reuses the destructive `error` state).
    if (leftoverSummaryOverride) {
      setLeftoverSummary(leftoverSummaryOverride)
    } else {
      setLeftoverSummary(null)
      setLeftoverLoading(true)
      void window.refract.sessions.deleteLeftoverSummary(session.id).then((response) => {
        if (cancelled) return
        setLeftoverLoading(false)
        if (!response.ok) return
        setLeftoverSummary(response.value)
      })
    }

    return () => {
      cancelled = true
    }
  }, [open, session.id, check, leftoverSummaryOverride])

  async function handleDelete(): Promise<void> {
    // Capture which Session this call is actually deleting: `session` is a prop that can
    // change (to a DIFFERENT Session) while this await is in flight, now that the dialog no
    // longer remounts on a Session change. `session.id` itself is useless for detecting that
    // after the await -- it's fixed by this ordinary closure to whatever it was when this
    // call started, so it can never disagree with `deletingId`. `sessionIdRef` is the live
    // value instead, reassigned on every render.
    const deletingId = session.id
    setDeleting(true)
    setError(null)
    const response = await window.refract.sessions.delete(deletingId, { confirmed: true })
    // The dialog may now belong to a different Session entirely (this component persists
    // across a Session change; see the effect above). If so, this stale resolution must not
    // touch `deleting`, `deletedRef`, or close whatever is currently open for the new Session.
    if (sessionIdRef.current !== deletingId) return
    setDeleting(false)
    if (!response.ok) {
      setError(response.error.message)
      // Issue #891 gate round (P4): a partial failure may have changed what git and the
      // filesystem actually show (some files could already be gone before a holder appeared,
      // or git's own registration state could have changed) -- refresh both reads so Retry's
      // own display, and the next Delete attempt, see current state rather than whatever was
      // true when the dialog first opened.
      if (!check) {
        setLoading(true)
        void window.refract.sessions.deleteCheck(deletingId).then((refreshed) => {
          if (sessionIdRef.current !== deletingId) return
          setLoading(false)
          if (refreshed.ok) setResult(refreshed.value)
        })
      }
      if (!leftoverSummaryOverride) {
        setLeftoverLoading(true)
        void window.refract.sessions.deleteLeftoverSummary(deletingId).then((refreshed) => {
          if (sessionIdRef.current !== deletingId) return
          setLeftoverLoading(false)
          if (refreshed.ok) setLeftoverSummary(refreshed.value)
        })
      }
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
        onEscapeKeyDown={(event) => {
          if (deleting) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Session {session.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes its worktree, its branch, and its Conversations.</AlertDialogDescription>
        </AlertDialogHeader>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking for uncommitted or unpushed work…
          </p>
        )}
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
        {leftoverLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking files…
          </p>
        )}
        {leftoverSummary && (leftoverSummary.generatedFolders.length > 0 || leftoverSummary.otherFiles.length > 0) && (
          <div className="min-w-0">
            {/* Issue #891 gate round (P3): "The list sits in its own bounded, keyboard-scrollable
                region with a label." Bounded (`max-h-40 overflow-y-auto`), labelled
                (`aria-labelledby`, not just a visual heading), and keyboard-reachable/scrollable
                (`tabIndex={0}` -- arrow keys and Page Up/Down scroll a focused, overflowing
                element natively, no custom key handling needed). */}
            <p id="leftover-files-label" className="text-sm font-medium">
              Files left in the worktree
            </p>
            <ul
              aria-labelledby="leftover-files-label"
              tabIndex={0}
              className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-sm break-all text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {leftoverSummary.generatedFolders.map((folder) => (
                <li key={folder.name}>
                  {folder.name} ({folder.fileCount} file{folder.fileCount === 1 ? '' : 's'})
                </li>
              ))}
              {leftoverSummary.otherFiles.map((path) => (
                <li key={path}>{path}</li>
              ))}
              {leftoverSummary.moreCount > 0 && <li>and {leftoverSummary.moreCount} more</li>}
            </ul>
          </div>
        )}
        {deleting && (
          <p role="status" className="sr-only">
            Deleting…
          </p>
        )}
        <p
          role="alert"
          className={cn('flex items-start gap-1.5 text-sm text-destructive [overflow-wrap:anywhere]', !error && 'sr-only')}
        >
          {error && <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />}
          {error ?? ''}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel
            aria-disabled={deleting}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              if (deleting) event.preventDefault()
            }}
          >
            Cancel
          </AlertDialogCancel>
          {/* Issue #891 gate round 1 item 2 (ui-architect-v3 ruling): after any refusal this
              same button relabels to Retry (still destructive, still the only filled button,
              same onClick) rather than gaining a second control -- every backend refusal
              message already ends "then choose Retry" to match. `error` clears at the start of
              a new attempt and at every fresh dialog open, so this reverts to "Delete" then. */}
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
            {deleting ? 'Deleting…' : error ? 'Retry' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
