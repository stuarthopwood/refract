import * as React from 'react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Diff, type GutterOptions, Hunk, isDelete, isInsert, parseDiff } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-view.css'
import { cn } from '@/lib/utils'
import { buildUnifiedDiff, countChanges } from '@/lib/diff'
import { DiffStatCounts } from '@/features/sessions/sessionDisplay'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { FileLinkButton } from './Markdown'

interface DiffViewProps {
  path: string
  oldText: string
  newText: string
  // Opt-in (#630): caps the diff body to about 24rem with its own scroll while collapsed, and adds
  // the header's Expand/Collapse control -- `ToolRow.tsx`'s own expanded `edit` call is the only
  // caller that passes this.
  capped?: boolean
}

// Line numbers alone don't say whether a row was added or removed; the CSS `::before` markers in
// diff-view.css are the visible cue, this sr-only text is the same information for AT users.
function renderGutter({ change, side, renderDefault }: GutterOptions) {
  return (
    <>
      {renderDefault()}
      {isInsert(change) && side === 'new' && <span className="sr-only">Added</span>}
      {isDelete(change) && side === 'old' && <span className="sr-only">Removed</span>}
    </>
  )
}

// Inert text throughout: react-diff-view tokenises the diff text itself, it never interprets it as
// markup.
export function DiffView({ path, oldText, newText, capped = false }: DiffViewProps) {
  // Memoised so the `canExpand` effect does not re-run on every render (including the Expand click).
  const patch = React.useMemo(() => buildUnifiedDiff(path, oldText, newText), [path, oldText, newText])
  const diffTooLarge = patch === undefined
  const parsed = React.useMemo(() => (patch ? parseDiff(patch)[0] : undefined), [patch])
  const changedFile = React.useMemo(() => (parsed && parsed.hunks.length > 0 ? parsed : undefined), [parsed])
  const [expanded, setExpanded] = React.useState(false)
  // Whether the collapsed cap actually clips anything (#630: "if the whole diff fits inside the
  // cap, show no Expand button") -- measured, not guessed, against the real rendered height.
  const [canExpand, setCanExpand] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const regionId = React.useId()

  const stats = React.useMemo(() => (changedFile ? countChanges(changedFile) : { added: 0, removed: 0 }), [changedFile])

  // A `ResizeObserver` (not a one-shot measurement) re-checks whenever the collapsed body's own
  // rendered height changes -- e.g. the pane resizing -- not only on mount or when the diff text
  // itself changes.
  React.useLayoutEffect(() => {
    if (!capped || expanded) return
    const el = bodyRef.current
    if (!el) return
    const measure = () => setCanExpand(el.scrollHeight > el.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [capped, expanded, patch])

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      {/* drag-regions-allow: a diff box's own header, nested inside an expanded `ToolRow` call in the chat transcript, always well below that screen's own real drag-region header (ChatHeader.tsx) -- it never touches App.tsx's permanent strip despite the `border-b` shape, same pattern as PullRequestDetail.tsx/ManageSessionsToolbar.tsx below. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-2 py-1 font-code text-xs text-muted-foreground">
        {/* `min-w-0 flex` lets the button size and truncate itself instead; `FileLinkButton`'s own `className` now carries `block max-w-full truncate` plus an inset focus ring so it is never drawn outside the header's own clipped bounds. */}
        <span className="min-w-0 flex">
          <FileLinkButton path={path} muted wrapperClassName="flex max-w-full min-w-0" className="block max-w-full truncate focus-visible:outline-offset-[-2px]" />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {/* #630: added/removed line counts from the parsed hunks, never colour alone (the leading +/- glyph is the same cue the gutter already uses). */}
          {changedFile && <DiffStatCounts added={stats.added} removed={stats.removed} accessibleLabel />}
          {/* Copies the full unified diff (git header plus hunks) shown below -- the same "copy exactly the displayed text" rule `CodeBlock`'s Copy button follows (#524); there is nothing to copy for an unchanged file, so the button only renders when a hunk exists. */}
          {changedFile && (
            <CopyButton
              getText={() => patch ?? ''}
              label={`Copy diff for ${path}`}
              announcement="Diff copied"
              className="-my-1 text-muted-foreground focus-visible:ring-inset"
            />
          )}
          {capped && canExpand && (
            <Button
              variant="ghost"
              size="xs"
              className="-my-1 text-muted-foreground focus-visible:ring-inset"
              aria-expanded={expanded}
              aria-controls={regionId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          )}
        </span>
      </div>
      {diffTooLarge ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">Diff too large to show</div>
      ) : !changedFile ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">No changes</div>
      ) : (
        // #630: a keyboard-focusable, named scroll region (WCAG 2.1.1, 1.4.10, 2.4.11) so Tab
        // reaches it and arrow/Page-Down keys scroll it even though nothing inside is itself
        // focusable; `ring-inset` keeps the focus ring inside this element's own clipped bounds
        // (the outer wrapper above is `overflow-hidden` for its rounded corners).
        <div
          ref={bodyRef}
          id={regionId}
          tabIndex={capped && !expanded && canExpand ? 0 : undefined}
          role="region"
          aria-label={`Diff of ${path}`}
          className={cn(
            'outline-none focus-visible:outline-hidden focus-visible:outline-offset-[-2px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            capped && !expanded && 'max-h-96 overflow-auto'
          )}
        >
          <Diff viewType="unified" diffType={changedFile.type} hunks={changedFile.hunks} renderGutter={renderGutter}>
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        </div>
      )}
    </div>
  )
}

interface DiffViewFromPatchProps {
  path: string
  // GitHub's REST `pulls/{n}/files` `patch` field -- unlike `DiffView`, this is NOT built from a
  // before/after pair via `buildUnifiedDiff`; it is wrapped with the same `diff --git a/<path>
  // b/<path>` header `parseDiff` needs and rendered through the identical
  // `Diff`/`Hunk`/`renderGutter` pipeline.
  patch: string
  // Issue #919: the pull request's own per-file additions/deletions (`ChangedFile.additions`/
  // `.deletions`), rendered next to the Copy button -- the mock's own per-file +/- acceptance
  // criterion from #568, never delivered until now.
  additions: number
  deletions: number
  // #1111 item 5: a binary/over-cap/unreadable/timed-out untracked file's own reason the backend
  // (`changes_diff.rs::untracked_file_patch`) could not render it as a patch -- shown below instead
  // of the otherwise-indistinguishable "No changes" fallback.
  reason?: string | null
  // Set ONLY by that panel's own call site; every other caller (`ChangesTab.tsx`) is unchanged and
  // keeps the path header.
  hideFileName?: boolean
}

/** GitHub's pull request diffs arrive as a ready-made patch body, not an old/new text pair -- this is `DiffView`'s sibling for that shape, sharing its rendering but not its diff-building. */
export function DiffViewFromPatch({ path, patch, reason, additions, deletions, hideFileName = false }: DiffViewFromPatchProps) {
  // Security remediation (Low): a GitHub file path can contain embedded CR/LF (git itself allows
  // it); interpolated raw into the diff header below, a crafted path could inject extra header or
  // hunk lines into both the parsed diff AND the exact text the Copy button puts on the clipboard.
  const safePath = path.replace(/[\r\n]/g, '')
  const wrapped = `diff --git a/${safePath} b/${safePath}
--- a/${safePath}
+++ b/${safePath}
${patch}`
  const parsed = parseDiff(wrapped)[0]
  const changedFile = parsed && parsed.hunks.length > 0 ? parsed : undefined

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-2 py-1 font-code text-xs text-muted-foreground">
        {!hideFileName && (
          <span className="min-w-0 truncate" title={path}>
            {path}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-2">
          <DiffStatCounts added={additions} removed={deletions} accessibleLabel />
          {changedFile && (
            <CopyButton
              getText={() => wrapped}
              label={`Copy diff for ${path}`}
              announcement="Diff copied"
              className="-my-1 text-muted-foreground focus-visible:ring-inset"
            />
          )}
        </span>
      </div>
      {!changedFile ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">{reason ?? 'No changes'}</div>
      ) : (
        <Diff viewType="unified" diffType={changedFile.type} hunks={changedFile.hunks} renderGutter={renderGutter}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  )
}
