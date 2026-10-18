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
  // Quality-gate remediation (Critical, round 2): `patch`/`parsed`/`changedFile` used to be
  // recomputed on every render (a fresh object each time), so the `canExpand` effect below
  // re-ran on every render too -- including the one caused by clicking Expand itself. Memoised
  // here on the real inputs (`path`/`oldText`/`newText`, then `patch`) so object identity is
  // stable across a render the diff text itself didn't change for.
  const patch = React.useMemo(() => buildUnifiedDiff(path, oldText, newText), [path, oldText, newText])
  // Gate round 1 (Main, D4): `undefined` means `lib/diff.ts` genuinely gave up past its own
  // `MAX_EDIT_LENGTH` cap -- a DIFFERENT fact than "no changes" (`''`/no hunks), which must not
  // read as "this edit did nothing".
  const diffTooLarge = patch === undefined
  const parsed = React.useMemo(() => (patch ? parseDiff(patch)[0] : undefined), [patch])
  // Quality-gate remediation (Medium): narrows to a single `changedFile` once, instead of a
  // `hasChanges` boolean paired with non-null `!` assertions at every later use -- the type
  // checker now actually proves `changedFile.hunks` is non-empty everywhere it's read.
  const changedFile = React.useMemo(() => (parsed && parsed.hunks.length > 0 ? parsed : undefined), [parsed])
  const [expanded, setExpanded] = React.useState(false)
  // Whether the collapsed cap actually clips anything (#630: "if the whole diff fits inside the
  // cap, show no Expand button") -- measured, not guessed, against the real rendered height.
  const [canExpand, setCanExpand] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const regionId = React.useId()

  // Gate round 1 (code-reviewer High, H2): shares `countChanges` with `lib/diff.ts`'s own
  // `diffStat` (ToolRow.tsx's "+N -M" row stat) instead of a second hand-rolled loop, so the
  // two can never disagree about the same diff.
  const stats = React.useMemo(() => (changedFile ? countChanges(changedFile) : { added: 0, removed: 0 }), [changedFile])

  // Quality-gate remediation (Critical, round 2): only ever measures (and so only ever flips
  // `canExpand`) while the body is actually capped and collapsed -- `expanded` short-circuits
  // the effect entirely once the user clicks Expand, so `canExpand` (and the Collapse button it
  // gates) can never be reset to `false` by the body losing its height cap. A `ResizeObserver`
  // (not a one-shot measurement) re-checks whenever the collapsed body's own rendered height
  // changes -- e.g. the pane resizing -- not only on mount or when the diff text itself changes.
  // Known accepted edge (round 3, LOW): `canExpand` is never re-measured WHILE expanded, so if
  // `patch` itself changes to something shorter while the user already has it expanded, Collapse
  // stays offered even once the (now-shorter) diff would fit uncapped; clicking it re-measures
  // truthfully and can then remove the button, moving focus to `<body>` the same way the
  // round-1 bug did. Rare in practice (an already-rendered edit's diff text does not normally
  // change shape after the fact) and not fixed here; a future fix would move focus to the path
  // link above when this transition is detected.
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
      {/* drag-regions-allow: a diff box's own header, nested inside an expanded `ToolRow` call in the chat transcript, always well below that screen's own real drag-region header (ChatHeader.tsx) -- it never touches App.tsx's permanent strip despite the `border-b` shape, same pattern as PullRequestDetail.tsx/ManageSessionsToolbar.tsx below. Gained an interactive opener (`capped`'s own Expand/Collapse `<Button>`) that `check:drag-regions` had not flagged before, since `CopyButton`/`FileLinkButton`'s own internal `<button>` aren't in its tag list. */}
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
           * leading +/- glyph is the same cue the gutter already uses). Issue #925 gate round 1
           * (M1, Decided, Skippy, delegated by Stuart 2026-10-18, posted on #925): this header
           * now renders through the SAME shared `DiffStatCounts` the Changes tab and its own
           * per-file header use, instead of its own raw `text-state-working`/`text-destructive`
           * spans -- one colouring rule (muted zero, green/red positive) and one minus glyph
           * (ASCII `-`, not the Unicode minus sign this header used to draw) everywhere a change
           * count shows, not two independently-styled copies that could drift apart. */}
          {changedFile && <DiffStatCounts added={stats.added} removed={stats.removed} accessibleLabel />}
          {/* Copies the full unified diff (git header plus hunks) shown below -- the same "copy
           * exactly the displayed text" rule `CodeBlock`'s Copy button follows (#524); there is
           * nothing to copy for an unchanged file, so the button only renders when a hunk exists.
           * Always visible (quality-gate round 2, issue #524's "visible without hover" AC); `-my-1`
           * keeps the 24px icon-xs target from growing this header past its original height. */}
          {changedFile && (
            <CopyButton
              getText={() => patch ?? ''}
              label={`Copy diff for ${path}`}
              announcement="Diff copied"
              className="-my-1 text-muted-foreground focus-visible:ring-inset"
            />
          )}
          {/* Quality-gate remediation (Medium, round 3): `focus-visible:ring-inset` -- at
           * `size="xs"` with `-my-1`, this button fills the header's own full height, the first
           * child of the outer `overflow-hidden` wrapper; without `ring-inset` its outside
           * `ring-3` box-shadow was clipped top and bottom, leaving only a sliver of the focus
           * ring visible either side. Matches the Copy button right next to it, which already
           * carries the same class for the same reason. */}
          {capped && canExpand && (
            <Button
              variant="ghost"
              size="xs"
              className="-my-1 text-muted-foreground focus-visible:ring-inset"
              aria-expanded={expanded}
              aria-controls={regionId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          )}
        </span>
      </div>
      {diffTooLarge ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">Diff too large to show</div>
      ) : !changedFile ? (
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        // #630: a keyboard-focusable, named scroll region (WCAG 2.1.1, 1.4.10, 2.4.11) so Tab
        // reaches it and arrow/Page-Down keys scroll it even though nothing inside is itself
        // focusable; `ring-inset` keeps the focus ring inside this element's own clipped bounds
        // (the outer wrapper above is `overflow-hidden` for its rounded corners). `tabIndex` is
        // only ever `0` while there is actually something to scroll (quality-gate, Low): a
        // non-overflowing or expanded region is not a useful Tab stop. `focus-visible:outline-
        // hidden` draws a `forced-colors`-only transparent outline (Windows High Contrast ignores
        // `box-shadow`, which is how the Tailwind `ring-*` utilities paint, matching
        // `radio-group.tsx`'s own fix for the same gap); `outline-offset-[-2px]` (quality-gate
        // remediation, Low, round 3) draws that outline INSIDE this element's own bounds, the
        // same inset pattern `FileLinkButton` above uses -- without it, the region's left/right/
        // bottom edges sit flush against the outer `overflow-hidden` wrapper and clip all but
        // the top edge of the outline in Windows High Contrast.
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
  /** Repository-relative path, shown as the header. */
  path: string
  /** An already-unified diff body (hunks starting `@@`), e.g. GitHub's REST `pulls/{n}/files`
   * `patch` field (specs/003-pull-request-management research.md decision 5, ChangesTab.tsx,
   * T017) -- unlike `DiffView`, this is NOT built from a before/after pair via `buildUnifiedDiff`;
   * it is wrapped with the same `diff --git a/<path> b/<path>` header `parseDiff` needs and
   * rendered through the identical `Diff`/`Hunk`/`renderGutter` pipeline. */
  patch: string
  /** Issue #919: the pull request's own per-file additions/deletions (`ChangedFile.additions`/
   * `.deletions`), rendered next to the Copy button -- the mock's own per-file +/- acceptance
   * criterion from #568, never delivered until now. Issue #925 colours it the same way
   * `DiffStatCounts` colours every other change count in the app, visually `aria-hidden` and
   * paired with its own `sr-only` "N additions M deletions" phrase (`DiffStatCounts`'s own
   * `accessibleLabel` prop, gate round 1 L1) -- not real plain accessible text itself, the
   * header's own path next to it is. `ChangesTab.tsx` is this component's only caller and
   * always has both figures on hand, so they are required, not optional. */
  additions: number
  deletions: number
}

/** GitHub's pull request diffs arrive as a ready-made patch body, not an old/new text pair --
 * this is `DiffView`'s sibling for that shape, sharing its rendering but not its diff-building. */
export function DiffViewFromPatch({ path, patch, additions, deletions }: DiffViewFromPatchProps) {
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
        <span className="min-w-0 truncate" title={path}>
          {path}
        </span>
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
        <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No changes</div>
      ) : (
        <Diff viewType="unified" diffType={changedFile.type} hunks={changedFile.hunks} renderGutter={renderGutter}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  )
}
