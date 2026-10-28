// Delete confirmation (FR-029, T042; contracts/ipc.md `sessions.deleteCheck`/`sessions.delete`):
// names exactly what a delete loses before it happens. Shared by the SessionList row menu and
// the ChatPane worktree-missing banner (FR-035), so it takes only the id/name it needs, not a
// full SessionSummary.
import { useEffect, useRef, useState } from 'react'
import { FileIcon, FolderIcon, Loader2Icon, OctagonXIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LeftoverSummary } from '../../../shared/ipc'
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

// Issue #891 gate round (M1): only the FIRST sentence of a backend refusal reads destructive
// red; every following sentence (the "how to fix it" instructions) reads as ordinary foreground
// text, so the most urgent fact is the one visually emphasised.
function splitFirstSentence(text: string): { first: string; rest: string } {
  const end = text.search(/[.!?](\s|$)/)
  if (end < 0) return { first: text, rest: '' }
  return { first: text.slice(0, end + 1), rest: text.slice(end + 1).trim() }
}

// Issue #891 gate round (M3): "normalise `..` in DISPLAYED paths lexically (never following
// links)" -- a pure string transform over the already-backend-provided relative path, never a
// filesystem call (so it can never itself resolve through a symlink/junction).
function normalizeDisplayPath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') {
      out.pop()
      continue
    }
    if (part === '.' || part === '') continue
    out.push(part)
  }
  return out.join('/')
}

// Issue #891 gate round (M2): the count summary shown once the walk settles -- "a count
// summary (e.g. 'Found 1 generated folder and 37 other files'), never the list itself."
function summarizeLeftovers(summary: LeftoverSummary): string {
  const folderCount = summary.generatedFolders.length
  const otherCount = summary.otherFiles.length + summary.moreCount
  const parts: string[] = []
  if (folderCount > 0) parts.push(`${folderCount} generated folder${folderCount === 1 ? '' : 's'}`)
  if (otherCount > 0) parts.push(`${otherCount.toLocaleString()} other file${otherCount === 1 ? '' : 's'}`)
  if (parts.length === 0) return 'Nothing left in the worktree'
  return `Found ${parts.join(' and ')}`
}

// Issue #891 gate round (M2): ONE `role="status"` line cycling through every coarse step --
// "Checking files…", then the count summary, then "Deleting N files…" during the delete call
// itself. Empty string renders nothing (a cleared/not-yet-started phase). Gate round 2 (M5):
// also folds in `deleteCheck`'s own "Checking for uncommitted or unpushed work…" line (no
// longer a separate, independently-mounted `<p>`), in order deleting, then checking (deleteCheck
// first, then the leftover walk), then the summary. Gate round 2 (H2): a `leftoverSummary`
// marked `unavailable` (the underlying `git status` call failed, timed out, or its own join
// failed) reads as "Couldn't list the folder's files.", the same text an outright IPC failure
// (`leftoverError`) already used -- never silently falls through to `summarizeLeftovers`, which
// would otherwise report a git failure as "Nothing left in the worktree".
function leftoverStatusText(
  deleting: boolean,
  loading: boolean,
  leftoverLoading: boolean,
  leftoverError: boolean,
  leftoverSummary: LeftoverSummary | null
): string {
  if (deleting) {
    if (leftoverSummary) {
      // Every file this call is actually removing: each generated folder's own real count plus
      // every other file (including the capped "more" overflow the visible list never lists).
      const total =
        leftoverSummary.generatedFolders.reduce((sum, folder) => sum + folder.fileCount, 0) +
        leftoverSummary.otherFiles.length +
        leftoverSummary.moreCount
      if (total > 0) return `Deleting ${total.toLocaleString()} file${total === 1 ? '' : 's'}…`
    }
    return 'Deleting…'
  }
  if (loading) return 'Checking for uncommitted or unpushed work…'
  if (leftoverLoading) return 'Checking files…'
  if (leftoverError || leftoverSummary?.unavailable) return "Couldn't list the folder's files."
  if (leftoverSummary) return summarizeLeftovers(leftoverSummary)
  return ''
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
  // Issue #891 gate round (M3): "a muted 'Couldn't list the folder's files.' when the walk
  // fails" -- distinct from `error` (the destructive, delete-refusing state): this is purely
  // informational, the same way the summary itself never gates Delete.
  const [leftoverError, setLeftoverError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Issue #891 gate round 2 (H1): set ONLY in `handleDelete`'s own `!response.ok` branch, never
  // by a `deleteCheck` failure on open -- `error` alone drove the button's Retry label before
  // this, so a dialog that opened straight into a failed `deleteCheck` (no loss summary ever
  // shown) still read "Retry", and pressing it called `handleDelete` directly: a real delete
  // attempt with no confirmation the user had ever seen. Cleared everywhere `error` clears.
  const [refused, setRefused] = useState(false)
  // Issue #891 gate round 2 (M4): a SEPARATE flag from `loading` for the P4 post-refusal
  // `deleteCheck` refresh -- `loading` also gates the Delete/Retry button's `aria-disabled`,
  // and that refresh must never grey out Retry while it runs in the background.
  const [refreshing, setRefreshing] = useState(false)
  // Issue #1055: a failed post-refusal re-check says so, instead of silently hiding the bullets.
  const [recheckFailed, setRecheckFailed] = useState(false)
  // Issue #891 gate round 3 (M4): Retry can be clicked again WHILE a previous attempt's own
  // post-failure refresh is still in flight (`refreshing` deliberately does not disable the
  // button) -- a generation counter so a stale refresh response from an EARLIER attempt can
  // never overwrite a fresher one, independent of `sessionIdRef`'s own cross-Session guard.
  const deleteGenerationRef = useRef(0)
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
    setRefused(false)
    setRefreshing(false)
    setRecheckFailed(false)
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
      setLeftoverError(false)
    } else {
      setLeftoverSummary(null)
      setLeftoverError(false)
      setLeftoverLoading(true)
      void window.refract.sessions.deleteLeftoverSummary(session.id).then((response) => {
        if (cancelled) return
        setLeftoverLoading(false)
        if (!response.ok) {
          setLeftoverError(true)
          return
        }
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
    const myGeneration = ++deleteGenerationRef.current
    setDeleting(true)
    setError(null)
    // Issue #891 gate round 3 (M4): cleared here too, not just on dialog open -- a NEW attempt
    // starting must never leave a PREVIOUS attempt's "Retry" label state lying around.
    setRefused(false)
    const response = await window.refract.sessions.delete(deletingId, { confirmed: true })
    // The dialog may now belong to a different Session entirely (this component persists
    // across a Session change; see the effect above), or a LATER attempt for the SAME Session
    // may already be in flight (the generation check). If so, this stale resolution must not
    // touch `deleting`, `deletedRef`, or close whatever is currently open.
    if (sessionIdRef.current !== deletingId || deleteGenerationRef.current !== myGeneration) return
    setDeleting(false)
    if (!response.ok) {
      setError(response.error.message)
      // Issue #891 gate round 2 (H1): only a `handleDelete` failure proves the user has seen
      // the loss summary before this specific Delete attempt actually ran -- this is the one
      // and only place `refused` is ever set `true`.
      setRefused(true)
      // Issue #891 gate round (P4): a partial failure may have changed what git and the
      // filesystem actually show (some files could already be gone before a holder appeared,
      // or git's own registration state could have changed) -- refresh both reads so Retry's
      // own display, and the next Delete attempt, see current state rather than whatever was
      // true when the dialog first opened. Issue #891 gate round 2 (M4): the deleteCheck
      // refresh uses its own `refreshing` flag, never `loading` -- `loading` also gates the
      // Delete/Retry button's `aria-disabled`, and this background refresh must never grey out
      // Retry for the several seconds it can take against a large worktree.
      if (!check) {
        setRefreshing(true)
        void window.refract.sessions.deleteCheck(deletingId).then((refreshed) => {
          if (sessionIdRef.current !== deletingId || deleteGenerationRef.current !== myGeneration) return
          setRefreshing(false)
          // Issue #891 gate round 3 (M4): a refresh that itself fails after a partial delete
          // must not keep showing the PRE-delete loss bullets as if they were still accurate
          // -- cleared, not left stale.
          setResult(refreshed.ok ? refreshed.value : null)
          setRecheckFailed(!refreshed.ok)
        })
      }
      if (!leftoverSummaryOverride) {
        setLeftoverLoading(true)
        void window.refract.sessions.deleteLeftoverSummary(deletingId).then((refreshed) => {
          if (sessionIdRef.current !== deletingId || deleteGenerationRef.current !== myGeneration) return
          setLeftoverLoading(false)
          if (!refreshed.ok) {
            setLeftoverError(true)
            // Issue #891 gate round 3 (M4): same stale-bullets fix for the leftover list --
            // the bounded `<ul>` renders from `leftoverSummary` directly, independent of
            // `leftoverError`, so it must be cleared too or it would keep showing the PRE-
            // delete file list underneath a status line that now says "Couldn't list...".
            setLeftoverSummary(null)
            return
          }
          // Issue #891 gate round 3 (M4): reset on a SUCCESSFUL refresh -- an earlier failed
          // refresh must not leave `leftoverError` stuck true forever once a later one works.
          setLeftoverError(false)
          setLeftoverSummary(refreshed.value)
        })
      }
      return
    }
    deletedRef.current = true
    onOpenChange(false)
  }

  const { first: errorFirst, rest: errorRest } = error ? splitFirstSentence(error) : { first: '', rest: '' }
  const statusText = leftoverStatusText(deleting, loading || refreshing, leftoverLoading, leftoverError, leftoverSummary)
  const hasLeftoverList = !!leftoverSummary && (leftoverSummary.generatedFolders.length > 0 || leftoverSummary.otherFiles.length > 0)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        size="md"
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
        {result && (result.uncommittedFiles > 0 || result.unpushedCommits > 0 || !result.hasUpstream) && (
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
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
        {recheckFailed && <p className="text-sm text-muted-foreground">Couldn't re-check what Delete would lose.</p>}
        {/* Issue #891 gate round (M2): ONE role="status" line for every coarse step of the
            leftover-files walk/delete, never the list itself (the list below is a separate,
            non-live element). Issue #891 gate round 2 (M5): ALWAYS mounted, never conditionally
            rendered on `statusText` being non-empty -- some assistive tech only announces a
            CHANGE to an already-present live region, not a node that appears for the first
            time. `min-h-5` keeps this row's own height constant as the icon and text come and
            go, matching the error box below's own established pattern. */}
        <p role="status" className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground">
          {deleting && <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />}
          {statusText}
        </p>
        {hasLeftoverList && leftoverSummary && (
          <div className="min-w-0">
            {/* Issue #891 gate round (P3): "The list sits in its own bounded, keyboard-scrollable
                region with a label." Bounded (`max-h-40 overflow-y-auto`), labelled
                (`aria-labelledby`, not just a visual heading), and keyboard-reachable/scrollable
                (`tabIndex={0}` -- arrow keys and Page Up/Down scroll a focused, overflowing
                element natively, no custom key handling needed). */}
            <p id="leftover-files-label" className="text-sm">
              Files left in the worktree
            </p>
            {/* Issue #891 gate round (M4): leading Folder/File icons replace disc bullets, so
                the list no longer needs `pl-4`'s own off-grid indent. */}
            <ul
              aria-labelledby="leftover-files-label"
              tabIndex={0}
              className="max-h-40 space-y-1 overflow-y-auto text-sm text-muted-foreground outline-none focus-visible:outline-hidden focus-visible:outline-offset-[-2px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {leftoverSummary.generatedFolders.map((folder) => (
                <li key={folder.name} className="flex min-w-0 items-start gap-2">
                  <FolderIcon aria-hidden className="mt-1 size-4 shrink-0" />
                  {/* Issue #891 gate round (M3): `font-code`/`[overflow-wrap:anywhere]` (never
                      `break-all`, which breaks mid-word anywhere rather than preferring a
                      boundary); counts unbracketed, `tabular-nums`, `toLocaleString()`. */}
                  <span className="min-w-0 flex-1 font-code [overflow-wrap:anywhere]">
                    {folder.name} — <span className="tabular-nums">{folder.fileCount.toLocaleString()}</span> file
                    {folder.fileCount === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
              {leftoverSummary.otherFiles.map((filePath) => (
                <li key={filePath} className="flex min-w-0 items-start gap-2">
                  <FileIcon aria-hidden className="mt-1 size-4 shrink-0" />
                  <span className="min-w-0 flex-1 font-code [overflow-wrap:anywhere]">
                    {leftoverSummary.rootName}/{normalizeDisplayPath(filePath)}
                  </span>
                </li>
              ))}
              {leftoverSummary.moreCount > 0 && (
                <li className="pl-6 text-xs">and {leftoverSummary.moreCount.toLocaleString()} more files</li>
              )}
            </ul>
          </div>
        )}
        {/* Issue #891 gate round (M1/M4): an `OctagonXIcon` (error, not `TriangleAlertIcon`'s
            own warning meaning), sr-only "Error: " prefix, only the first sentence destructive
            red (the rest reads as ordinary foreground instruction text), `[overflow-wrap:anywhere]`
            for a long path. `min-h-5` keeps this box's own height constant whether or not it
            holds text, so the footer below never jumps as a Retry clears and re-sets `error`. */}
        <div
          id="delete-dialog-error"
          role="alert"
          className={cn('flex min-h-5 min-w-0 items-start gap-2 text-sm [overflow-wrap:anywhere]')}
        >
          {error && (
            <>
              <OctagonXIcon aria-hidden className="mt-1 size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">
                <span className="sr-only">Error: </span>
                <span className="text-destructive">{errorFirst}</span>
                {errorRest && <span className="text-foreground"> {errorRest}</span>}
              </p>
            </>
          )}
        </div>
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
              message already ends "then choose Retry" to match. Issue #891 gate round 2 (H1):
              the label reads `refused`, never bare `error` -- a `deleteCheck` failure on open
              also sets `error` (its own message already explains itself) but must NEVER show
              Retry, since no loss summary has ever been shown for this Session yet; `refused`
              is set only inside `handleDelete`'s own failure branch. Both clear at the start of
              a new attempt and at every fresh dialog open, so this reverts to "Delete" then. */}
          <AlertDialogAction
            variant="destructive"
            aria-disabled={loading || deleting}
            aria-describedby="delete-dialog-error"
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              event.preventDefault()
              if (loading || deleting) return
              void handleDelete()
            }}
          >
            {deleting ? 'Deleting…' : refused ? 'Retry' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
