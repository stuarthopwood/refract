import * as React from 'react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Diff, type GutterOptions, Hunk, isDelete, isInsert, parseDiff } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-view.css'
import { cn } from 'cn'
import { buildUnifiedDiff } from '@/lib/diff'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { FileLinkButton } from './Markdown'

interface DiffViewProps {
  /** Repository-relative or absolute path, shown as the header. */
  path: string
  oldText: string
  newText: string
  /** Opt-in (#630): caps the diff body to about 24rem with its own scroll while collapsed, and
   * adds the header's Expand/Collapse control -- `ToolRow.tsx`'s own expanded `edit` call is the
   * only caller that passes this. `DiffViewFromPatch` below (the PR Changes tab) never does, so
   * that view keeps rendering the whole diff uncapped, unchanged by this issue. */
  capped?: boolean
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
export function DiffView({ path, oldText, newText, capped = false }: DiffViewProps) {
  const patch = buildUnifiedDiff(path, oldText, newText)
  const parsed = patch ? parseDiff(patch)[0] : undefined
  // Quality-gate remediation (Medium): narrows to a single `changedFile` once, instead of a
  // `hasChanges` boolean paired with non-null `!` assertions at every later use -- the type
  // checker now actually proves `changedFile.hunks` is non-empty everywhere it's read.
  const changedFile = parsed && parsed.hunks.length > 0 ? parsed : undefined
  const [expanded, setExpanded] = React.useState(false)
  // Whether the collapsed cap actually clips anything (#630: "if the whole diff fits inside the
  // cap, show no Expand button") -- measured, not guessed, once against the real rendered
  // height, while the body still renders in its capped, collapsed form below.
  const [canExpand, setCanExpand] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)

  const stats = React.useMemo(() => {
    if (!changedFile) return { added: 0, removed: 0 }
    let added = 0
    let removed = 0
    for (const hunk of changedFile.hunks) {
      for (const change of hunk.changes) {
        if (isInsert(change)) added++
        else if (isDelete(change)) removed++
      }
    }
    return { added, removed }
  }, [changedFile])

  React.useLayoutEffect(() => {
    if (!capped) return
    const el = bodyRef.current
    setCanExpand(el != null && el.scrollHeight > el.clientHeight)
  }, [capped, changedFile])

  return (
    <div className="diff-view overflow-hidden rounded-md border border-border">
      {/* drag-regions-allow: a diff box's own header, nested inside an expanded `ToolRow`/`DiffViewFromPatch` inside the chat transcript or the PR Changes tab, always well below that screen's own real drag-region header (ChatHeader.tsx/PullRequestsView.tsx) -- it never touches App.tsx's permanent strip despite the `border-b` shape, same pattern as PullRequestDetail.tsx/ManageSessionsToolbar.tsx below. */}
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
        <span className="flex shrink-0 items-center gap-2">
          {/* #630: added/removed line counts from the parsed hunks, never colour alone (the
           * leading +/− glyph is the same cue the gutter already uses). */}
          {changedFile && (
            <span className="tabular-nums">
              <span className="text-green-600">+{stats.added}</span> <span className="text-destructive">−{stats.removed}</span>
            </span>
          )}
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
          {capped && canExpand && (
            <Button
              variant="ghost"
              size="sm"
              className="-my-1 h-auto gap-1 px-1.5 py-0.5 text-muted-foreground"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          )}
        </span>
      </div>
      {!changedFile ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        // #630: a keyboard-focusable, named scroll region (WCAG 2.1.1, 1.4.10, 2.4.11) so Tab
        // reaches it and arrow/Page-Down keys scroll it even though nothing inside is itself
        // focusable; `ring-inset` keeps the focus ring inside this element's own clipped bounds
        // (the outer wrapper above is `overflow-hidden` for its rounded corners).
        <div
          ref={bodyRef}
          tabIndex={0}
          role="region"
          aria-label={`Diff of ${path}`}
          className={cn(
            'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
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
