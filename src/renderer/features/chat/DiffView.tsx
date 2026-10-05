import { Diff, type GutterOptions, Hunk, isDelete, isInsert, parseDiff } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-view.css'
import { buildUnifiedDiff } from '@/lib/diff'

interface DiffViewProps {
  /** Repository-relative or absolute path, shown as the header. */
  path: string
  oldText: string
  newText: string
}

// Line numbers alone don't say whether a row was added or removed; the CSS `::before` markers
// in diff-view.css are the visible cue, this sr-only text is the same information for AT users.
function renderGutter({ change, side, renderDefault }: GutterOptions) {
  return (
    <>
      {renderDefault()}
      {isInsert(change) && side === 'new' && <span className="sr-only">Added</span>}
      {isDelete(change) && side === 'old' && <span className="sr-only">Removed</span>}
    </>
  )
}

// Renders one file's change as a unified diff (T025 ToolRow: `edit` and `write` tool results).
// `oldText === ''` renders as an added file. Inert text throughout: react-diff-view tokenises
// the diff text itself, it never interprets it as markup.
export function DiffView({ path, oldText, newText }: DiffViewProps) {
  const patch = buildUnifiedDiff(path, oldText, newText)
  const file = patch ? parseDiff(patch)[0] : undefined

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      <div className="truncate border-b border-border bg-muted px-2.5 py-1 font-code text-xs text-muted-foreground" title={path}>
        {path}
      </div>
      {!file || file.hunks.length === 0 ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        <Diff viewType="unified" diffType={file.type} hunks={file.hunks} renderGutter={renderGutter}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  )
}

interface DiffViewFromPatchProps {
  /** Repository-relative path, shown as the header. */
  path: string
  /** An already-unified diff body (hunks starting `@@`), e.g. GitHub's REST `pulls/{n}/files`
   * `patch` field (specs/003-pull-request-management research.md decision 5, ChangesTab.tsx,
   * T017) -- unlike `DiffView`, this is NOT built from a before/after pair via `buildUnifiedDiff`;
   * it is wrapped with the same `diff --git a/<path> b/<path>` header `parseDiff` needs and
   * rendered through the identical `Diff`/`Hunk`/`renderGutter` pipeline. */
  patch: string
}

/** GitHub's pull request diffs arrive as a ready-made patch body, not an old/new text pair --
 * this is `DiffView`'s sibling for that shape, sharing its rendering but not its diff-building. */
export function DiffViewFromPatch({ path, patch }: DiffViewFromPatchProps) {
  const wrapped = `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
${patch}`
  const file = parseDiff(wrapped)[0]

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      <div className="truncate border-b border-border bg-muted px-2.5 py-1 font-code text-xs text-muted-foreground" title={path}>
        {path}
      </div>
      {!file || file.hunks.length === 0 ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        <Diff viewType="unified" diffType={file.type} hunks={file.hunks} renderGutter={renderGutter}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  )
}
