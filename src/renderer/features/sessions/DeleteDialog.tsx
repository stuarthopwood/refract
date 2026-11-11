import { useEffect, useRef, useState } from 'react'
import { FileIcon, FolderIcon, Loader2Icon } from 'lucide-react'
import type { LeftoverSummary } from '../../../shared/ipc'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { useSessionsStore } from '@/state/sessions-store'
import { InlineStatus } from '@/components/InlineStatus'

interface DeleteCheck {
  uncommittedFiles: number
  unpushedCommits: number
  hasUpstream: boolean
}

function splitFirstSentence(text: string): { first: string; rest: string } {
  const end = text.search(/[.!?](\s|$)/)
  if (end < 0) return { first: text, rest: '' }
  return { first: text.slice(0, end + 1), rest: text.slice(end + 1).trim() }
}

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

// Single status line for the coarse steps; the list itself is never announced.
function summarizeLeftovers(summary: LeftoverSummary): string {
  const folderCount = summary.generatedFolders.length
  const otherCount = summary.otherFiles.length + summary.moreCount
  const parts: string[] = []
  if (folderCount > 0) parts.push(`${folderCount} generated folder${folderCount === 1 ? '' : 's'}`)
  if (otherCount > 0) parts.push(`${otherCount.toLocaleString()} other file${otherCount === 1 ? '' : 's'}`)
  if (parts.length === 0) return 'Nothing left in the worktree'
  return `Found ${parts.join(' and ')}`
}

function leftoverStatusText(
  deleting: boolean,
  rechecking: boolean,
  loading: boolean,
  leftoverLoading: boolean,
  leftoverError: boolean,
  leftoverSummary: LeftoverSummary | null
): string {
  if (deleting) {
    if (leftoverSummary) {
      const total =
        leftoverSummary.generatedFolders.reduce((sum, folder) => sum + folder.fileCount, 0) +
        leftoverSummary.otherFiles.length +
        leftoverSummary.moreCount
      if (total > 0) return `Deleting ${total.toLocaleString()} file${total === 1 ? '' : 's'}…`
    }
    return 'Deleting…'
  }
  if (rechecking) return 'Rechecking…'
  if (loading) return 'Checking for uncommitted or unpushed work…'
  if (leftoverLoading) return 'Checking files…'
  if (leftoverError || leftoverSummary?.unavailable) return "Couldn't list the folder's files. Delete still removes everything in it."
  if (leftoverSummary) return summarizeLeftovers(leftoverSummary)
  return ''
}

export interface DeleteDialogProps {
  session: { id: string; name: string }
  open: boolean
  onOpenChange(open: boolean): void
  check?: DeleteCheck
  leftoverSummary?: LeftoverSummary
  onDeleted?(): void
  onCancelled?(): void
  /** Seeds the dialog as a failed attempt (the toast's Details): message shown, confirm reads Retry. */
  initialError?: string
}
export function DeleteDialog({
  session,
  open,
  onOpenChange,
  check,
  leftoverSummary: leftoverSummaryOverride,
  onDeleted,
  onCancelled,
  initialError
}: DeleteDialogProps) {
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<DeleteCheck | null>(check ?? null)
  const [leftoverLoading, setLeftoverLoading] = useState(false)
  const [leftoverSummary, setLeftoverSummary] = useState<LeftoverSummary | null>(leftoverSummaryOverride ?? null)
  const [leftoverError, setLeftoverError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // a failed post-refusal re-check says so, instead of silently hiding the bullets.
  const [recheckFailed, setRecheckFailed] = useState(false)
  const deleteGenerationRef = useRef(0)
  const leftoverListRef = useRef<HTMLUListElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const deletedRef = useRef(false)
  const sessionIdRef = useRef(session.id)
  sessionIdRef.current = session.id

  useEffect(() => {
    if (!open) return
    // A refresh or delete still in flight from an earlier open must not write into this one.
    deleteGenerationRef.current++
    deletedRef.current = false
    setDeleting(false)
    setError(initialError ?? null)
    setRefused(!!initialError)
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
  }, [open, session.id, check, leftoverSummaryOverride, initialError])

  async function handleDelete(): Promise<void> {
    const deletingId = session.id
    const myGeneration = ++deleteGenerationRef.current
    setDeleting(true)
    setError(null)
    // Marked before the IPC so a fast result event can't be re-added after it clears the row; cleared on refusal.
    useSessionsStore.getState().markDeleting(deletingId)
    const response = await window.refract.sessions.delete(deletingId, { confirmed: true })
    if (response.ok) useSessionsStore.getState().confirmDeleting(deletingId)
    else useSessionsStore.getState().clearDeleting(deletingId)
    // If so, this stale resolution must not touch `deleting`, `deletedRef`, or close whatever is currently open.
    if (sessionIdRef.current !== deletingId || deleteGenerationRef.current !== myGeneration) return
    setDeleting(false)
    if (!response.ok) {
      setError(response.error.message)
      setRefused(true)
      if (!check) {
        setRefreshing(true)
        void window.refract.sessions.deleteCheck(deletingId).then((refreshed) => {
          if (sessionIdRef.current !== deletingId || deleteGenerationRef.current !== myGeneration) return
          setRefreshing(false)
          // a refresh that itself fails after a partial delete must not keep showing the PRE-delete loss bullets as if they were still accurate -- cleared, not left stale.
          setResult(refreshed.ok ? refreshed.value : null)
          setRecheckFailed(!refreshed.ok)
        })
      }
      if (!leftoverSummaryOverride) {
        // The list is replaced below; keep focus off the outline-less dialog container.
        if (leftoverListRef.current?.contains(document.activeElement)) confirmRef.current?.focus()
        setLeftoverLoading(true)
        void window.refract.sessions.deleteLeftoverSummary(deletingId).then((refreshed) => {
          if (sessionIdRef.current !== deletingId || deleteGenerationRef.current !== myGeneration) return
          // The refreshed result may unmount the list (error or empty); move focus off it first.
          if (leftoverListRef.current?.contains(document.activeElement)) confirmRef.current?.focus()
          setLeftoverLoading(false)
          if (!refreshed.ok) {
            setLeftoverError(true)
            setLeftoverSummary(null)
            return
          }
          // reset on a SUCCESSFUL refresh -- an earlier failed refresh must not leave `leftoverError` stuck true forever once a later one works.
          setLeftoverError(false)
          setLeftoverSummary(refreshed.value)
        })
      }
      return
    }
    // The backend returns once its checks pass; the row stays Deleting… until the result events arrive.
    deletedRef.current = true
    onOpenChange(false)
  }

  const rechecking = refused && (loading || refreshing || leftoverLoading)
  const statusBusy = deleting || loading || refreshing || leftoverLoading
  const statusText = leftoverStatusText(deleting, rechecking, loading || refreshing, leftoverLoading, leftoverError, leftoverSummary)
  const hasLeftoverList = !!leftoverSummary && (leftoverSummary.generatedFolders.length > 0 || leftoverSummary.otherFiles.length > 0)

  return (
    <ConfirmAlertDialog
      open={open}
      busy={deleting}
      confirmRef={confirmRef}
      confirmDisabled={loading || refreshing}
      size="md"
      tone="destructive"
      title={`Delete Session ${session.name}?`}
      description="This removes its worktree, its branch, and its Conversations."
      confirmLabel={refused ? 'Retry' : 'Delete'}
      busyLabel="Deleting…"
      error={error}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void handleDelete()}
      onCloseAutoFocus={() => {
        if (deletedRef.current) {
          deletedRef.current = false
          onDeleted?.()
        } else {
          onCancelled?.()
        }
      }}
    >
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
      {recheckFailed && <InlineStatus className="p-0">Couldn't re-check what Delete would lose.</InlineStatus>}
      <InlineStatus tone="loading" className="flex min-h-5 items-center gap-2 p-0">
        {statusBusy && <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />}
        {statusText}
      </InlineStatus>
      {hasLeftoverList && leftoverSummary && (
        <div className="min-w-0">
          <p id="leftover-files-label" className="text-sm">
            Files left in the worktree
          </p>
          <ul
            ref={leftoverListRef}
            aria-labelledby="leftover-files-label"
            tabIndex={0}
            className="max-h-40 space-y-1 overflow-y-auto text-sm text-muted-foreground outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {leftoverSummary.generatedFolders.map((folder) => (
              <li key={folder.name} className="flex min-w-0 items-start gap-2">
                <FolderIcon aria-hidden className="mt-1 size-4 shrink-0" />
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
    </ConfirmAlertDialog>
  )
}
