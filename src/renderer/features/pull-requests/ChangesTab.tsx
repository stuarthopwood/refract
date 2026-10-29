// The Changes tab (specs/003-pull-request-management FR-009, FR-011, T017): changed files, total
// additions/deletions, each file's diff via the existing `DiffView.tsx`'s `DiffViewFromPatch`,
// and -- when a file's `patch` is `null` -- a truncation banner plus an "Open in browser" action
// (a plain external link; Electron's existing `setWindowOpenHandler` routes it to
// `shell.openExternal`, no new IPC, matching `ReadoutItem.tsx`'s own external-link pattern).
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
    return <p className="p-4 text-sm text-muted-foreground">No changed files.</p>
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="text-sm text-muted-foreground">
        {files.length} file{files.length === 1 ? '' : 's'} changed, <DiffStatCounts added={additions} removed={deletions} accessibleLabel />
      </p>
      {files.length < changedFilesCount && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-4 py-1 text-xs text-muted-foreground">
          <span>
            Only {files.length} of {changedFilesCount} changed files are shown.
          </span>
          <a href={`${url}/files`} target="_blank" rel="noreferrer noopener" className="flex shrink-0 items-center gap-1 underline underline-offset-2">
            Open in browser
            <ExternalLinkIcon aria-hidden className="size-4" />
          </a>
        </div>
      )}
      {files.map((file) => (
        <div key={file.path} className="flex flex-col gap-1">
          {file.patch !== null ? (
            <DiffViewFromPatch path={file.path} patch={file.patch} additions={file.additions} deletions={file.deletions} />
          ) : (
            // Gate round 2 (M4 follow-up, Decided, Skippy, delegated by Stuart 2026-10-18,
            // posted on #925): the earlier cut rendered this file's "too large" message TWICE --
            // a standalone banner above this block plus a second "Diff not shown." line inside
            // it, each with its own "Open in browser" link. One block now: the header's own
            // link is the only one, the "too large" text replaces the old placeholder line.
            <div className="overflow-hidden rounded-md border border-border">
              {/* drag-regions-allow: renders inside PullRequestDetail's Changes tab, well below PullRequestsView's own h-10 drag-region strip, so it never touches App.tsx's strip despite the coincidental border-b shape -- same pattern as the identical bg-muted header in DiffView.tsx. */}
              <div
                data-slot="diff-fallback-header"
                className="flex items-center justify-between gap-2 border-b border-border bg-muted px-2 py-1 font-code text-xs text-muted-foreground"
              >
                <span className="min-w-0 truncate" title={file.path}>
                  {file.path}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <DiffStatCounts added={file.additions} removed={file.deletions} accessibleLabel />
                  <a
                    href={`${url}/files`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex h-6 shrink-0 items-center gap-1 -my-1 font-ui underline underline-offset-2"
                  >
                    Open in browser
                    <ExternalLinkIcon aria-hidden className="size-4" />
                  </a>
                </span>
              </div>
              <div className="px-2 py-1 text-xs text-muted-foreground">This file's diff is too large to show in full.</div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
