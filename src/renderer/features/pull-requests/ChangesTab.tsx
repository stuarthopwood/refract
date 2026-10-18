// The Changes tab (specs/003-pull-request-management FR-009, FR-011, T017): changed files, total
// additions/deletions, each file's diff via the existing `DiffView.tsx`'s `DiffViewFromPatch`,
// and -- when a file's `patch` is `null` -- a truncation banner plus an "Open in browser" action
// (a plain external link; Electron's existing `setWindowOpenHandler` routes it to
// `shell.openExternal`, no new IPC, matching `ReadoutChip.tsx`'s own external-link pattern).
import { ExternalLinkIcon } from 'lucide-react'
import type { ChangedFile } from '../../../shared/github'
import { DiffViewFromPatch } from '@/features/chat/DiffView'
import { DiffStatCounts } from '@/features/sessions/sessionDisplay'

interface ChangesTabProps {
  additions: number
  deletions: number
  /** The pull request's own total changed-file count (FR-009); compared against `files.length`
   * to show a list-level truncation note when the REST files call itself failed entirely (its own
   * `--paginate` fix covers the common "more than one page" case -- this is the remaining,
   * rarer "REST call failed, fell back to the porcelain field" case, distinct from the existing
   * per-file `patch === null` truncation banner). */
  changedFilesCount: number
  files: ChangedFile[]
  /** The pull request's own GitHub URL; the Files tab anchor for a specific path is appended. */
  url: string
}

export function ChangesTab({ additions, deletions, changedFilesCount, files, url }: ChangesTabProps) {
  if (files.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">No changed files.</p>
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-sm text-muted-foreground">
        {files.length} file{files.length === 1 ? '' : 's'} changed, <DiffStatCounts added={additions} removed={deletions} />
      </p>
      {files.length < changedFilesCount && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            Only {files.length} of {changedFilesCount} changed files are shown.
          </span>
          <a href={`${url}/files`} target="_blank" rel="noreferrer noopener" className="flex shrink-0 items-center gap-1 underline underline-offset-2">
            Open in browser
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </div>
      )}
      {files.map((file) => (
        <div key={file.path} className="flex flex-col gap-1">
          {file.patch === null && (
            <div role="status" className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <span>This file's diff is too large to show in full.</span>
              <a
                href={`${url}/files`}
                target="_blank"
                rel="noreferrer noopener"
                className="flex shrink-0 items-center gap-1 underline underline-offset-2"
              >
                Open in browser
                <ExternalLinkIcon aria-hidden className="size-3" />
              </a>
            </div>
          )}
          {file.patch !== null ? (
            <DiffViewFromPatch path={file.path} patch={file.patch} additions={file.additions} deletions={file.deletions} />
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="truncate border-b border-border bg-muted px-2.5 py-1 font-code text-xs text-muted-foreground" title={file.path}>
                {file.path}
              </div>
              <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                <DiffStatCounts added={file.additions} removed={file.deletions} /> (diff not shown)
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
