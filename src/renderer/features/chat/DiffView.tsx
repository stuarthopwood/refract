import { Diff, type GutterOptions, Hunk, isDelete, isInsert, parseDiff } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-view.css'
import { buildUnifiedDiff } from '@/lib/diff'
import { CopyButton } from '@/components/ui/copy-button'
import { FileLinkButton } from './Markdown'

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
  const parsed = patch ? parseDiff(patch)[0] : undefined
  // Quality-gate remediation (Medium): narrows to a single `changedFile` once, instead of a
  // `hasChanges` boolean paired with non-null `!` assertions at every later use -- the type
  // checker now actually proves `changedFile.hunks` is non-empty everywhere it's read.
  const changedFile = parsed && parsed.hunks.length > 0 ? parsed : undefined

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-2.5 py-1 font-code text-xs text-muted-foreground">
        {/* Quality-gate fix (A11y HIGH, round 2): the old `<span className="truncate">` wrapper
         * clipped the button's own focus ring (an inline-block child of an `overflow:hidden`
         * flex item) and gave the inline-block button no ellipsis of its own on a long path.
         * `min-w-0 flex` lets the button size and truncate itself instead; `FileLinkButton`'s own
         * `className` now carries `block max-w-full truncate` plus an inset focus ring so it is
         * never drawn outside the header's own clipped bounds. Muted: this header is a
         * `bg-muted` surface. `DiffViewFromPatch` below (the PR Changes-tab use) has no Session
         * to resolve against and deliberately keeps its own header plain text, not sharing this
         * markup. */}
        <span className="min-w-0 flex">
          <FileLinkButton path={path} muted className="block max-w-full truncate focus-visible:outline-offset-[-2px]" />
        </span>
        {/* Copies the full unified diff (git header plus hunks) shown below -- the same "copy
         * exactly the displayed text" rule `CodeBlock`'s Copy button follows (#524); there is
         * nothing to copy for an unchanged file, so the button only renders when a hunk exists.
         * Always visible (quality-gate round 2, issue #524's "visible without hover" AC); `-my-1`
         * keeps the 24px icon-xs target from growing this header past its original height. */}
        {changedFile && (
          <CopyButton
            getText={() => patch}
            label="Copy diff"
            announcement="Diff copied"
            className="-my-1 text-muted-foreground focus-visible:ring-inset"
          />
        )}
      </div>
      {!changedFile ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        <Diff viewType="unified" diffType={changedFile.type} hunks={changedFile.hunks} renderGutter={renderGutter}>
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
  // Security remediation (Low): a GitHub file path can contain embedded CR/LF (git itself
  // allows it); interpolated raw into the diff header below, a crafted path could inject extra
  // header or hunk lines into both the parsed diff AND the exact text the Copy button puts on
  // the clipboard. Stripped here, once, so parsing and copying always agree. The visible
  // `title`/text below still shows the real path -- it is a React text node, never markup.
  const safePath = path.replace(/[\r\n]/g, '')
  const wrapped = `diff --git a/${safePath} b/${safePath}
--- a/${safePath}
+++ b/${safePath}
${patch}`
  const parsed = parseDiff(wrapped)[0]
  const changedFile = parsed && parsed.hunks.length > 0 ? parsed : undefined

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-2.5 py-1 font-code text-xs text-muted-foreground">
        <span className="truncate" title={path}>
          {path}
        </span>
        {changedFile && (
          <CopyButton
            getText={() => wrapped}
            label="Copy diff"
            announcement="Diff copied"
            className="-my-1 text-muted-foreground focus-visible:ring-inset"
          />
        )}
      </div>
      {!changedFile ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        <Diff viewType="unified" diffType={changedFile.type} hunks={changedFile.hunks} renderGutter={renderGutter}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  )
}
