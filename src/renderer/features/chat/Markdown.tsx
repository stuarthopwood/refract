import * as React from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@/lib/utils'
import type { Highlighter } from 'shiki'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { MermaidConfig } from 'mermaid'
import { safeUrl } from '@/lib/safe-url'
import { parseFileReference, looksWithinWorktree } from '@/lib/linkify'
import { THEMES } from '../../../shared/themes'
import { MERMAID_THEME_VARIABLES, getMermaidThemeCSS } from '../../../shared/mermaidTheme'
import { toast } from 'sonner'
// Quality-gate fix (Code3 Medium, round 4): `notify` is no longer used -- the only call
// (`FileLinkButton`'s error path) was replaced with `toast.error` directly in round 3; it now
// appears only in this file's own comments.
import { useActiveThemeId, useSessionsStore } from '@/state'
import { CopyButton } from '@/components/ui/copy-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { linkClassName, mutedLinkClassName } from './linkStyles'

// react-markdown's own `urlTransform` prop (default: `defaultUrlTransform`) runs on every
// href/src BEFORE a node reaches its `components` renderer, so `safeUrl`'s relative-href block
// must live here, not only in the `a`/`img` components below -- otherwise a component-level
// allowance (e.g. for footnote anchors) is moot because `href`/`src` already arrived blanked.
// GFM footnote reference/backref anchors are same-page `#...fn...` fragments (added by
// remark-gfm/mdast-util-to-hast, marked with the hast properties `dataFootnoteRef`/
// `dataFootnoteBackref` -- rehype-sanitize's default schema preserves both, per its
// `lib/schema.js`) and can never reach main's `shell.openExternal`, so they are let through
// (with one adjustment) unchanged; every other href/src still goes through `safeUrl`'s
// http(s)-only rule.
//
// The adjustment: `Markdown` below passes a per-message `remarkRehypeOptions.clobberPrefix`
// (instead of mdast-util-to-hast's own default, `'user-content-'`) so that two messages in the
// same transcript never collide on e.g. `#user-content-fn-1`. But rehype-sanitize's *default
// schema* (used unmodified, see the comment on `ReactMarkdown` below) ALSO clobbers every `id`/
// `name` property by prepending its own hardcoded `'user-content-'` (hast-util-sanitize
// `lib/schema.js`'s `clobberPrefix`, not configurable from here without a custom schema) -- but
// it never touches `href`/`src`. So after sanitize, a footnote target's `id` ends up
// `user-content-<our-prefix>fn-1` while its reference's `href` is only `#<our-prefix>fn-1`
// (verified via an SSR probe of react-markdown + rehype-sanitize's actual output): the fragment
// and the id it should resolve to no longer match. This re-adds the single `user-content-`
// sanitize prepends to `id`, and only to `id`, so the href matches again.
function markdownUrlTransform(value: string, _key: string, node: { properties?: Record<string, unknown> }): string {
  const properties = node.properties ?? {}
  const isFootnoteAnchor = 'dataFootnoteRef' in properties || 'dataFootnoteBackref' in properties
  if (isFootnoteAnchor && value.startsWith('#')) return `#user-content-${value.slice(1)}`
  return safeUrl(value) ?? ''
}

// One Shiki highlighter for the whole renderer, created lazily on first code block and reused.
// `createJavaScriptRegexEngine` avoids loading the WASM oniguruma engine in the sandboxed
// renderer (research.md decision 2, "Not verified": chosen for that reason, not benchmarked).
// Languages are loaded on demand, not bundled up front.
let highlighterPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: Object.values(THEMES).map((theme) => theme.syntaxTheme),
    langs: [],
    engine: createJavaScriptRegexEngine()
  })
  return highlighterPromise
}

// Small header shown above every code block -- a markdown fence, and (via ToolRow's own
// language inference) a tool call's Arguments/Output (T083, FR-049/FR-050): the language's name
// when it is both known and actually highlighted, else "text" -- including when `lang` was given
// but Shiki failed to load or highlight it (the plain-fallback branch below), so the header never
// claims a highlight the body does not show. `bg-card` (#975: was `bg-muted`) now matches the body's own surface in every theme (see `CodeBlock`'s own effect for the neutralised Shiki background).
// `copyText` is the full, untruncated value the Copy button puts on the clipboard -- distinct
// from `label` (the language shown) so a caller whose visible body is capped (ToolRow.tsx's
// "Show all" truncation) can still copy the complete original text (#524, PLAN.md "Code
// snippets" row). The button is always rendered (never hover/focus-only, quality-gate round 2:
// issue #524's own "visible without hover" acceptance criterion), `-my-1` so the 24px icon-xs
// target doesn't grow this header past its original ~24px row height, and hidden entirely when
// `copyText` is empty (an untagged empty fence, or a tool call with no output) so Copy never
// silently clears the user's clipboard. The accessible name/tooltip includes the same language
// label shown in the header ("Copy code, typescript"), per the issue's intended behaviour, so
// multiple blocks in one transcript are distinguishable in a screen reader's button list.
function CodeBlockHeader({ label, copyText }: { label: string; copyText: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-2 py-1 font-code text-xs text-muted-foreground">
      <span className="truncate">{label}</span>
      {copyText !== '' && (
        <CopyButton
          getText={() => copyText}
          label={`Copy code, ${label}`}
          announcement="Code copied"
          className="-my-1 text-muted-foreground focus-visible:ring-inset"
        />
      )}
    </div>
  )
}

// PR #671 gate round 4 fix (Medium, Sec4): above this size, `CodeBlock` skips Shiki entirely
// (treated the same as `lang: null`) rather than ever calling the synchronous, main-thread
// `codeToHtml` -- see `CodeBlock`'s own effect for the measured cost this caps.
const MAX_HIGHLIGHT_BYTES = 200 * 1024
// The one shared code-block renderer (T083, FR-049/FR-050), exported for `ToolRow.tsx`'s
// Arguments/Output blocks. Always full width (FR-049). Every block's header carries a Copy
// button (#524), reversing this component's earlier "no copy button per FR-050/FR-042" rule.
export function CodeBlock({
  code,
  lang,
  wrap = false,
  lineNumbers = false,
  copyText,
}: {
  code: string
  lang: string | null
  // Opt-in wrapping for prose-shaped surfaces (an approval card's detail lines, a subagent's
  // Prompt/Result) that previously scrolled sideways like real code instead of wrapping like
  // every other paragraph in the transcript (T083, code-reviewer/test-reviewer/accessibility-auditor,
  // round 2). Every other `CodeBlock` caller -- markdown's own untagged fences, a tool call's
  // Arguments/Output, a `write` call's content preview -- keeps the original no-wrap/scroll-sideways
  // behavior: `lang === null` also covers ASCII diagrams, tables, and any non-JSON tool output, none
  // of which should wrap.
  wrap?: boolean
  // PR #671 gate round 4 fix (High, Verif4, FR-012): opt-in line-number gutter -- `false` for
  // every EXISTING caller (chat's own untagged fences, tool Arguments/Output, approval-card detail
  // lines, subagent Prompt/Result all keep their exact current rendering, zero change). Only
  // `FilePreviewPane.tsx`'s own text-file preview (Slice 2) passes `true`. Rendered as a separate
  // gutter COLUMN (not a CSS-counter-on-Shiki's-own-`.line`-spans trick, which only the HIGHLIGHTED
  // branch could use at all): one row per `code.split('\n')` entry, independent of whatever Shiki
  // did internally, so the same gutter code covers the highlighted AND plain-text paths uniformly.
  // Gutter numbers only line up one-per-SOURCE-line when each source line renders as exactly one
  // VISUAL row -- true whenever `wrap` is off (the default), false once a long line wraps onto a
  // second visual row. Rather than ship a misaligned gutter, `lineNumbers` is simply not rendered
  // while `wrap` is also on; a huge file is still wrappable (the MAX_HIGHLIGHT_BYTES/Wrap fixes
  // above), just without the gutter for as long as wrap stays on.
  lineNumbers?: boolean
  // The text the Copy button puts on the clipboard, when it differs from the visible `code`
  // (#524): `ToolRow.tsx` passes the full Output/write value here while `code` itself is capped
  // to the visible "Show all" slice. Defaults to `code` for every other caller.
  copyText?: string
}) {
  const activeThemeId = useActiveThemeId()
  const [html, setHtml] = React.useState<string | null>(null)

  React.useEffect(() => {
    setHtml(null)
    // PR #671 gate round 4 fix (Medium, Sec4, reproduced live): `codeToHtml` runs SYNCHRONOUSLY
    // on the renderer's one JS thread -- a real 2.1 MB TypeScript file took 10.7s and produced
    // 21.8 MB of HTML, freezing the WHOLE renderer (chat included, not just this one block) for
    // the duration. Above `MAX_HIGHLIGHT_BYTES`, `lang` is treated the same as `null`: the
    // existing plain-`<pre>` fallback below is correct and instant, just unhighlighted -- a huge
    // file is still readable and (with the wrap fix below) still wrappable, never a frozen UI.
    if (!lang || code.length > MAX_HIGHLIGHT_BYTES) return
    let cancelled = false
    void (async () => {
      try {
        const highlighter = await getHighlighter()
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          // `lang` comes from agent-authored fence info, not a validated list; shiki throws for
          // an unknown name and the catch below falls back to the plain <pre><code>.
          await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
        }
        if (cancelled) return
        // #975: body now shares `bg-card` with the header/gutter; Shiki's own fixed root
        // background is neutralised via `colorReplacements` (keyed on the theme's own `.bg`, probed against shiki@4.4.3 -- the one per-call override for background alone).
        const syntaxTheme = THEMES[activeThemeId].syntaxTheme
        const themeBg = highlighter.getTheme(syntaxTheme).bg.toLowerCase()
        setHtml(highlighter.codeToHtml(code, { lang, theme: syntaxTheme, colorReplacements: { [themeBg]: 'transparent' } }))
      } catch {
        if (!cancelled) setHtml(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, lang, activeThemeId])

  const label = html ? lang! : 'text'
  // Named for a screen reader and keyboard-reachable on its own (the block's content is never
  // otherwise focusable): a sighted keyboard user who tabs to a wide block needs to know it is
  // its own horizontally-scrolling region, not stuck reading the outer wrapper's clipped edge.
  const regionLabel = `${label} code block`
  // `focus-visible:ring-inset` draws the ring *inside* the scrollable element's own box instead of
  // outside it, so the outer wrapper's `overflow-hidden` (needed to clip the body to the header's
  // rounded corners) can never clip the ring off on the left/right/bottom.
  const scrollableClassName = 'overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
  // PR #671 gate round 4 fix (Medium, Sec4): `wrap` now applies regardless of `lang`/`html` --
  // previously gated to `lang === null` on the theory that only untagged/prose content ever
  // passed `wrap: true`, which held for every caller THEN (an approval card's detail lines, a
  // subagent's Prompt/Result, both always `lang: null`) but broke `FilePreviewPane.tsx`'s own
  // Wrap toggle (Slice 2), which passes a REAL guessed language for most source files -- Shiki
  // highlighted them (`html` set), and the wrap class was never applied to that branch at all, so
  // the button visibly did nothing. Every existing `wrap: true` caller still only ever has
  // `lang: null` content, so this is a strict widening, not a behaviour change for them.
  const wrapClassName = 'whitespace-pre-wrap break-words outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
  const showLineNumbers = lineNumbers && !wrap
  const lineCount = showLineNumbers ? code.split('\n').length : 0

  // Gate round 5 fix (Code5 Medium): a single text node, not one `<div>` per line -- the
  // previous version allocated 30-60k DOM nodes for a ~1 MiB file's own gutter alone (this
  // component's own `MAX_HIGHLIGHT_BYTES`/Wrap-fix comment above already accepts files that
  // large), with no virtualisation. `leading-[1.6]` matches the content column's own line
  // height exactly (both the Shiki-highlighted and plain-text branches below already set it the
  // same way), so each `\n`-joined number still lines up with its own source line.
  const gutter = showLineNumbers ? (
    <pre
      aria-hidden
      className="m-0 select-none border-r border-border bg-card py-4 pl-4 pr-2 text-right leading-[1.6] text-muted-foreground tabular-nums"
    >
      {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
    </pre>
  ) : null

  if (html) {
    // Shiki's own HTML output (highlighted spans only, no agent text interpreted as markup,
    // per the constitution's markdown/sanitisation rule). `bg-card` on this div (#975, matching
    // the plain-fallback `<pre>` below) paints the body now Shiki's own bg is neutralised above.
    return (
      <div className="not-prose max-w-none overflow-hidden rounded-lg border border-border text-xs">
        <CodeBlockHeader label={label} copyText={copyText ?? code} />
        <div className="flex">
          {gutter}
          <div
            tabIndex={0}
            role="region"
            aria-label={regionLabel}
            className={cn(
              'min-w-0 flex-1 bg-card',
              wrap ? wrapClassName : scrollableClassName,
              wrap ? '[&>pre]:m-0 [&>pre]:p-4 [&>pre]:whitespace-pre-wrap [&>pre]:break-words' : '[&>pre]:m-0 [&>pre]:p-4 [&>pre]:leading-[1.6]'
            )}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    )
  }
  return (
    <div className="not-prose max-w-none overflow-hidden rounded-lg border border-border text-xs">
      <CodeBlockHeader label={label} copyText={copyText ?? code} />
      <div className="flex">
        {gutter}
        <pre
          tabIndex={0}
          role="region"
          aria-label={regionLabel}
          className={cn('min-w-0 flex-1', wrap ? wrapClassName : scrollableClassName, 'bg-card p-4 leading-[1.6]')}
        >
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

// A unified diff's own hunk/file markers, checked against the start of the text (T083, FR-050).
const DIFF_PATTERN = /^(?:---|\+\+\+) |^@@ -|^diff --git /m

// Language inference for an arbitrary code/text surface (T083, FR-050, docs/DESIGN.md "Every
// JSON-shaped tool/code surface uses `CodeBlock`"): `diff` when the raw text itself looks like a
// unified diff, `json` (pretty-printed, replacing the original unparsed/compact text) when it
// parses as JSON, otherwise plain `text` (`lang: null` skips Shiki entirely -- there is no
// language to try loading). Shared by every tool/code surface in the transcript -- a tool call's
// Output, a subagent's Prompt/Result, and a pending approval card's detail lines -- so none of
// them render raw, unformatted text outside `CodeBlock`.
export function inferOutputBlock(text: string): { lang: string | null; code: string } {
  if (DIFF_PATTERN.test(text)) return { lang: 'diff', code: text }
  try {
    return { lang: 'json', code: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { lang: null, code: text }
  }
}

// Mermaid is loaded lazily (dynamic `import()`) only once the first ```mermaid fence actually
// appears, so it never adds to the main bundle (T066). `securityLevel: 'strict'` is mermaid's
// default and, per its own docs (config/schema-docs/config-properties-securitylevel.html),
// disables click callbacks and encodes HTML in labels; `secure` additionally defaults to
// `['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']`
// (config-properties-secure.html), so a `%%{init}%%` directive in agent-authored diagram source
// cannot override `securityLevel`, or `suppressErrorRendering` (set below), back to `'loose'`/
// `false` -- confirmed live in docs/spike/FINDINGS.md.
// `mermaid.render()` is NOT off-DOM: it selects `document.body`, appends a temporary div+SVG
// there, sets `style.innerHTML` from the diagram's own classDef CSS, serializes the SVG to a
// string, then removes the temporary node -- all synchronously, in the live document, before
// returning. The live protection during that brief in-DOM step is the pinned version (11.17.2,
// past CVE-2026-41148/-41149), `securityLevel: 'strict'`, and Mermaid's own internal DOMPurify
// sanitization pass over the serialized SVG -- not DOM avoidance. `suppressErrorRendering: true`
// (below) additionally stops a parse error from drawing Mermaid's own error diagram into that
// temporary node and throwing before `removeTempElements()` runs, which previously left an orphan
// node in `document.body` on every failed (or re-rendered, e.g. on a theme flip) diagram.
// Once rendered, the SVG string is shown as an inert `data:image/svg+xml` <img>, never inserted
// into the DOM as live markup: that is what makes the FINAL DISPLAYED output inert (disables
// script execution regardless of `securityLevel`, per MDN "SVG as an image": "JavaScript is
// disabled" in image contexts) -- it is not what keeps the render step itself off the DOM.
// `bindFunctions` (mermaid's click-handler attacher) is intentionally never called.
const MERMAID_MAX_SOURCE_BYTES = 50_000
const MERMAID_RENDER_TIMEOUT_MS = 5_000

let mermaidPromise: Promise<typeof import('mermaid')> | null = null
function getMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid')
  return mermaidPromise
}

// Readable fallback names for Mermaid's internal `diagramType` id (e.g. the literal string
// `flowchart-v2`), used as the image's accessible name only when the diagram source supplied no
// `accTitle` of its own.
const MERMAID_DIAGRAM_TYPE_LABELS: Record<string, string> = {
  'flowchart-v2': 'flowchart diagram',
  flowchart: 'flowchart diagram',
  sequence: 'sequence diagram',
  classDiagram: 'class diagram',
  class: 'class diagram',
  stateDiagram: 'state diagram',
  state: 'state diagram',
  er: 'entity-relationship diagram',
  journey: 'user journey diagram',
  gantt: 'Gantt chart',
  pie: 'pie chart',
  quadrantChart: 'quadrant chart',
  requirement: 'requirement diagram',
  gitGraph: 'git graph diagram',
  mindmap: 'mind map diagram',
  timeline: 'timeline diagram',
  sankey: 'sankey diagram'
}
function mermaidDiagramTypeLabel(diagramType: string): string {
  return MERMAID_DIAGRAM_TYPE_LABELS[diagramType] ?? `${diagramType} diagram`
}

// Mermaid writes a diagram's own `accTitle:`/`accDescr:` directives into the rendered SVG's
// top-level `<title>`/`<desc>` elements. An `<img>` hides those from assistive tech, so they are
// read back out here (via an inert `DOMParser` parse, which runs no scripts) and re-exposed as
// the image's accessible name/description (FR-043).
function parseMermaidSvgMeta(svg: string): { title: string | null; desc: string | null } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const title = doc.documentElement.querySelector(':scope > title')?.textContent?.trim() || null
  const desc = doc.documentElement.querySelector(':scope > desc')?.textContent?.trim() || null
  return { title, desc }
}

function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const activeThemeId = useActiveThemeId()
  const [showSource, setShowSource] = React.useState(false)
  const [result, setResult] = React.useState<{
    svg: string
    diagramType: string
    title: string | null
    desc: string | null
  } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const reactId = React.useId().replace(/:/g, '-')
  const sourceId = `mermaid-source-${reactId}`
  const descId = `mermaid-desc-${reactId}`

  React.useEffect(() => {
    setError(null)
    // Only draw once the reply has stopped streaming: an in-progress fence is incomplete
    // diagram source, not invalid diagram source, so showing the raw block (not a failure
    // reason) while `streaming` is true is the correct fallback (T066). Only reset `result` here,
    // not on every re-render (e.g. a theme flip): keeping the last-good result mounted until the
    // new render resolves keeps the Show-source button/panel in place so focus never drops to
    // `<body>` if the button had it.
    if (streaming) {
      setResult(null)
      return
    }
    const byteLength = new TextEncoder().encode(code).length
    if (byteLength > MERMAID_MAX_SOURCE_BYTES) {
      setError(`source is ${Math.round(byteLength / 1000)} KB, over the ${MERMAID_MAX_SOURCE_BYTES / 1000} KB cap`)
      return
    }
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      try {
        const mermaid = (await getMermaid()).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'dark',
          themeVariables: MERMAID_THEME_VARIABLES[activeThemeId],
          // Quality-gate remediation (round 5): patches real Mermaid CSS gaps no `themeVariables`
          // key can reach alone (Gantt active/activeCrit overflow labels, Gantt clickable labels
          // against the done bar, Timeline section-10's brightness-filtered fill) -- see
          // `getMermaidThemeCSS`'s own comment in mermaidTheme.ts.
          themeCSS: getMermaidThemeCSS(activeThemeId)
        } satisfies MermaidConfig)
        const rendered = await Promise.race([
          mermaid.render(`mermaid-${reactId}`, code),
          new Promise<never>((_resolve, reject) => {
            // Guards only against an unexpectedly slow async resolution, not as a hard cap on
            // CPU-bound layout time: `mermaid.render()` is synchronous once it starts and cannot
            // be interrupted mid-layout. The real CPU-time bound is the size cap above plus
            // Mermaid's own built-in `maxEdges` limit (observed working, FINDINGS item 26).
            timeoutId = setTimeout(() => reject(new Error('render timed out after 5s')), MERMAID_RENDER_TIMEOUT_MS)
          })
        ])
        if (cancelled) return
        const { title, desc } = parseMermaidSvgMeta(rendered.svg)
        setResult({ svg: rendered.svg, diagramType: rendered.diagramType, title, desc })
      } catch (err) {
        if (!cancelled) setError((err instanceof Error ? err.message : String(err)).slice(0, 200))
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }
    })()
    return () => {
      cancelled = true
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }, [code, activeThemeId, streaming, reactId])

  if (streaming) {
    return <CodeBlock code={code} lang="mermaid" />
  }
  if (error) {
    return (
      <div className="space-y-1">
        <p role="status" className="text-xs text-muted-foreground">
          Diagram failed to render: {error}
        </p>
        <CodeBlock code={code} lang="mermaid" />
      </div>
    )
  }
  if (!result) {
    return <CodeBlock code={code} lang="mermaid" />
  }
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`
  const accessibleName = result.title || `Mermaid ${mermaidDiagramTypeLabel(result.diagramType)}`
  const describedBy = result.desc ? descId : sourceId
  return (
    <div className="space-y-1">
      <img
        src={dataUrl}
        role="img"
        aria-label={accessibleName}
        aria-describedby={describedBy}
        className="max-w-full rounded-lg border border-border bg-card p-2"
      />
      {result.desc && (
        <span id={descId} className="sr-only">
          {result.desc}
        </span>
      )}
      <InlineDisclosure
        open={showSource}
        onOpenChange={setShowSource}
        contentId={sourceId}
        label={showSource ? `Hide source for ${accessibleName}` : `Show source for ${accessibleName}`}
      >
        <CodeBlock code={code} lang="mermaid" />
      </InlineDisclosure>
    </div>
  )
}

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ className, ...props }: React.ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag className={    cn('font-bold', className)} {...props} />
  }
}

// `code` reads the surface's `streaming` flag from `StreamingContext` (T066: draw a Mermaid
// fence only once the reply has stopped streaming) rather than closing over it, so this map is a
// static module-level object built once -- rebuilding it per `streaming` flip previously gave
// every component (a, p, table, code, ...) a new function identity on each flip, forcing React to
// unmount and remount the whole markdown subtree (and every CodeBlock's Shiki-highlighted state
// with it) the moment a streaming reply finished.
const StreamingContext = React.createContext(false)

// Issue #610: the owning Session's id, read by every link/file-link renderer below so it never
// has to be threaded as a prop through `Markdown`/`ToolRow`/`DiffView`'s whole call chain --
// `Transcript.tsx` is the one place that provides it (never `ChatPane.tsx`, so this stays clear
// of #621's own `ChatPane.tsx` changes). `null` outside a Session context (e.g. a PR diff's
// `DiffViewFromPatch`, a PR description/timeline/review, or `SubagentPanel` if it is ever used
// without one) or if a caller forgets to wrap -- `FileLinkButton` below falls back to plain,
// unstyled text in that case, never a link-styled control that does nothing.
export const LinkContext = React.createContext<string | null>(null)

// Quality-gate fix (Code/Verif Medium, round 2): a link/file-link rendered INSIDE a markdown
// `<a>`'s own children (e.g. `` [`src/x.ts`](https://example.com) ``) must never become a SECOND
// nested interactive element -- invalid HTML, two tab stops, and a click on the inner control
// bubbling up to also activate the outer anchor. Set to `true` only by the `a` renderer, around
// everything it renders; `code` below returns its plain, non-interactive chip whenever this
// reads `true`, skipping URL/path detection entirely.
const InsideLinkContext = React.createContext(false)

// Issue #610, decision 9: one shared class for every link-shaped control -- `--accent-text` plus
// a permanent underline (never colour alone, WCAG 1.4.1), gated at least 4.5:1 against
// `--background`/`--card`/`--popover` (check-theme-contrast.mjs) and against the user message
// bubble's own composited `accent/50`-on-`background` fill (verified 4.69:1 in Dark, the binding
// theme -- see that script's own `user-bubble` pair). `rounded-sm` plus the achromatic
// `focus-visible` ring matches every other control in the app; `[overflow-wrap:anywhere]` stops a
// long URL/path from forcing the row to scroll sideways. Moved to `./linkStyles.ts` (issue #1077,
// gate round 1 fix) so `InlineDisclosure` can reuse `mutedLinkClassName` without an import cycle
// back through this file (which itself imports `InlineDisclosure` for `MermaidBlock`); re-exported
// here unchanged so every existing caller of `./Markdown` keeps working with no other change.
export { linkClassName, mutedLinkClassName }

// Quality-gate fix (Verif Low, round 2): the streaming-inert state is plain text that cannot be
// activated -- it must never carry the active state's `hover:`/`focus-visible:` classes, which
// would suggest a control that responds to hover or can take focus when neither is true.
const inertLinkClassName = 'text-accent-text underline underline-offset-2 [overflow-wrap:anywhere]'
const mutedInertLinkClassName = 'underline underline-offset-2 [overflow-wrap:anywhere]'

// Issue #610, decision 7: every WEB link gets a Radix tooltip naming the real destination, on
// hover AND keyboard focus -- this app has no browser status bar, so this is the only way to see
// where a link actually goes before activating it (the issue's own named mitigation for a
// prompt-injected link whose visible text and destination differ). `aria-describedby` (never
// `aria-label`, which would discard the link's own visible text as its accessible name when that
// text is NOT simply the href, e.g. a markdown `[Click here](https://x)`) adds the destination as
// a DESCRIPTION, read after the name, without ever replacing it -- satisfies WCAG 2.5.3 Label in
// Name unconditionally, with no text-equality branching needed. Shared by the `a` renderer, the
// `img` alt-text fallback, and the inline-code URL case below.
interface ExternalLinkProps extends Omit<React.ComponentPropsWithoutRef<'a'>, 'href' | 'className' | 'children'> {
  href: string
  className: string
  children: React.ReactNode
}

function ExternalLink({ href, className, children, title: _title, ...rest }: ExternalLinkProps) {
  // Quality-gate fix (A11y3 Low, round 4): a markdown link's own `title` (`[x](url "t")`,
  // forwarded here via `rest` since round 3) is agent-written text that could show a plausible
  // but FAKE destination in the browser's native `title` tooltip, layered right on top of this
  // component's own Radix tooltip naming the REAL destination -- confusing at best, actively
  // misleading at worst. Screen readers were never affected (`aria-describedby` already takes
  // priority over `title` for the accessible description), so this is purely a sighted-UI fix:
  // destructured out and discarded, never reaching the underlying `<a>`.
  const describedById = React.useId()
  // Quality-gate fix (Sec2/Verif2 Medium, round 3): `shown` is the URL object's own canonical
  // serialization -- punycode host, every bidi-override/zero-width/control character percent-
  // encoded -- displayed instead of the raw `href` string. A homograph host (Cyrillic look-alike
  // of a real domain) or an RTL-override trick in the path previously rendered as whatever the
  // attacker typed in BOTH the tooltip and the hidden description, while the browser actually
  // navigated to the punycode/percent-encoded form -- the tooltip's whole job (decision 7: "name
  // the real destination") was defeated exactly when it mattered most. `safeUrl` (lib/safe-url.ts)
  // now already returns this canonical form itself, so this is belt-and-braces: correct even if a
  // future caller ever passes an `href` that bypassed `safeUrl`. Wrapped in `<bdi dir="ltr">` so an
  // RTL-override character that survived percent-encoding (there is none, `encodeURI`-shaped
  // percent-encoding covers every bidi control point) still cannot visually reverse the string.
  const shown = new URL(href).href
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          {...rest}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className={className}
          aria-describedby={describedById}
        >
          {children}
        </a>
      </TooltipTrigger>
      <TooltipContent className="[overflow-wrap:anywhere]">
        Open in browser: <bdi dir="ltr">{shown}</bdi>
      </TooltipContent>
      {/* Quality-gate fix (A11y2/Code2 Medium, round 3): `hidden` (not `sr-only`) -- `aria-describedby`
          still reads a `hidden` element's text content per spec, but `hidden` (unlike
          visually-hidden-but-still-in-the-tree `sr-only`) removes it from the copy/paste
          selection and from the accessibility tree's normal reading-order flow entirely, so it
          can never pollute a sighted user's clipboard or get double-read by an AT's own browse
          mode alongside the description. */}
      <span id={describedById} hidden>
        Open in browser: <bdi dir="ltr">{shown}</bdi>
      </span>
    </Tooltip>
  )
}

interface FileLinkButtonProps {
  /** The bare path this sends to `sessions.revealFile` -- never includes a `:line[:col]` suffix
   * (ignored for navigation until #463's file viewer exists, decision 3). */
  path: string
  /** Visible text and tooltip label; defaults to `path`. */
  display?: string
  /** `true` on a `bg-muted` surface (inline code, `DiffView`'s header) -- see `mutedLinkClassName`. */
  muted?: boolean
  /** Decision 6: inert (plain underlined text, unfocusable) while the owning message still
   * streams, so a path cut off mid-generation is never followed and no focusable control
   * appears inside the live `role="log"` region mid-stream. */
  streaming?: boolean
  /** Layout-only (e.g. `DiffView`'s own truncate/focus-ring-inset rules); merged onto whichever
   * of the three branches below actually renders, so a caller's own sizing rule always applies
   * regardless of state. */
  className?: string
}

// Issue #610: the one file-link control app-wide, exported for `ToolRow.tsx` (write/edit path
// lines) and `DiffView.tsx` (header path) to reuse, the same pattern `CodeBlock` below already
// establishes for tool-call Arguments/Output. "Show in File Explorer", never "Open" -- running a
// file's own OS default verb (`shell.openPath`) would execute a `.cmd`/`.ps1`/`.lnk` an agent or
// tool wrote; `sessions.revealFile` only ever calls `shell.showItemInFolder`.
export function FileLinkButton({ path, display, muted = false, streaming = false, className }: FileLinkButtonProps) {
  const sessionId = React.useContext(LinkContext)
  const worktreePath = useSessionsStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.worktreePath : undefined
  )
  const label = display ?? path
  // Decision 8: a cheap, string-only early-out for an absolute path obviously outside the
  // worktree -- never the security boundary itself (that is `resolveInWorktree`, main-process,
  // on click), just a visual nicety that avoids linkifying something that can only ever fail.
  const withinWorktree = worktreePath === undefined || looksWithinWorktree(path, worktreePath)

  // Quality-gate fix (Code/A11y HIGH, round 2): nothing to click at all outside a real Session
  // context (a PR description/timeline/review, `SubagentPanel` without a provider) or for a path
  // obviously outside the worktree -- PLAIN, unstyled text, not a link-styled span that does
  // nothing. `title` restores the full path a caller's own truncation would otherwise hide.
  if (!sessionId || !withinWorktree) {
    return (
      <span className={className} title={label}>
        {label}
      </span>
    )
  }

  if (streaming) {
    return (
      <span className={cn(muted ? mutedInertLinkClassName : inertLinkClassName, className)} title={label}>
        {label}
      </span>
    )
  }

  const activeClassName = muted ? mutedLinkClassName : linkClassName
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(activeClassName, className)}
          aria-label={`Show in File Explorer: ${label}`}
          // Quality-gate fix (A11y3/Code3/Verif3 Low, round 4): round 3's `aria-hidden` on
          // `TooltipContent` below does NOT stop the double announcement it was meant to --
          // Radix sets `aria-describedby` to the tooltip's own id on this button while the
          // tooltip is open regardless, and `aria-describedby` still reads a directly-referenced
          // node's text even when that node is `aria-hidden` (the exact same accname rule
          // `ExternalLink`'s own `hidden` span above relies on -- the two fixes contradicted each
          // other). Fixed here instead: an explicit `aria-describedby={undefined}` on THIS
          // element. Radix's `Slot`/`mergeProps` gives the child's own prop precedence, so this
          // blocks Radix from setting its own `aria-describedby` at all -- nothing points at the
          // tooltip, and the button's `aria-label` alone is read, once.
          aria-describedby={undefined}
          onClick={() => {
            void window.refract.sessions.revealFile(sessionId, path).then((result) => {
              // Quality-gate fix (Verif2 Medium, round 3): the decision comment asks for a
              // dismiss-until-cleared toast for THIS error specifically (file-not-found/outside-
              // worktree can be a stale/wrong file reference the user needs a moment to read and
              // act on, not a transient blip) -- `notify()`'s own default (auto-dismissing,
              // shared by every other IPC error app-wide) stays untouched; this is a local
              // `toast.error` call, not a change to `notify()` itself.
              if (!result.ok) toast.error(result.error.message, { duration: Infinity, closeButton: true })
            })
          }}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="[overflow-wrap:anywhere]">
        Show in File Explorer: {label}
      </TooltipContent>
    </Tooltip>
  )
}

// Named (rather than inline arrows) so the `li` task-list-item renderer below can recognize a
// direct child as "a nested paragraph wrapper (loose lists)" / "a nested sub-list" / "the
// checkbox itself" by function identity -- the only reliable signal available once react-markdown
// has already turned those nodes into opaque React elements typed by these very components.
function Paragraph({ className, ...props }: React.ComponentProps<'p'> & ExtraProps) {
  return <p className={className} {...props} />
}
// `contains-task-list` (added by remark-gfm's tasklist handling) drops the bullet marker and
// tightens spacing so the checkbox sits where the bullet would; an ordinary list keeps the
// existing disc/decimal marker.
function UnorderedList({ className, ...props }: React.ComponentProps<'ul'> & ExtraProps) {
  return (
    <ul
      className={cn(
        typeof className === 'string' && className.includes('contains-task-list')
          ? 'list-none space-y-1 pl-0'
          : 'list-disc pl-4',
        className
      )}
      {...props}
    />
  )
}
function OrderedList({ className, ...props }: React.ComponentProps<'ol'> & ExtraProps) {
  return <ol className={cn('list-decimal pl-4', className)} {...props} />
}
// Task-list checkboxes (GFM): rehype-sanitize's default (GitHub-style) schema already allows
// `input[type=checkbox][disabled]` and `li.task-list-item` (hast-util-sanitize
// lib/schema.js), so no schema extension was needed for T065; this only themes the checkbox.
function TaskCheckbox({ className, ...props }: React.ComponentProps<'input'> & ExtraProps) {
  return <input className={cn('mr-1 align-middle accent-primary', className)} {...props} />
}

// Clones the task-list-item's checkbox (always its first real child, per remark-gfm) with
// `aria-labelledby`, and wraps everything after it in an id'd <span> so that id has something to
// point at -- giving the checkbox an accessible name without a <label> wrapper (see `li` below).
function labelTaskCheckbox(children: React.ReactNode, labelId: string): React.ReactNode[] {
  const nodes = React.Children.toArray(children)
  const checkboxIndex = nodes.findIndex((node) => React.isValidElement(node) && node.type === TaskCheckbox)
  if (checkboxIndex === -1) return nodes
  const checkbox = nodes[checkboxIndex] as React.ReactElement<{ 'aria-labelledby'?: string }>
  return [
    ...nodes.slice(0, checkboxIndex),
    React.cloneElement(checkbox, { 'aria-labelledby': labelId }),
    <span key="task-list-item-label" id={labelId}>
      {nodes.slice(checkboxIndex + 1)}
    </span>
  ]
}

// Labels only a `task-list-item` <li>'s OWN leading content (its checkbox + its own text), never
// its subtree: a loose list wraps that own content in a <p> (handled by recursing into just that
// paragraph's children), and either loose or tight, a sub-task-list nested under this item is its
// own sequence of `task-list-item` <li>s that will each run through this same renderer again, with
// their own id. Excluding both is required for valid HTML -- <label>'s content model is phrasing
// content only, so a wrapping <label> around a nested <p> or <ul> was already invalid before
// nesting is even considered -- and for a correct accessible name -- a parent checkbox's name must
// not swallow every descendant item's text too.
function renderTaskListItemChildren(children: React.ReactNode, labelId: string): React.ReactNode {
  const nodes = React.Children.toArray(children)
  const looseIndex = nodes.findIndex((node) => React.isValidElement(node) && node.type === Paragraph)
  if (looseIndex !== -1) {
    const paragraph = nodes[looseIndex] as React.ReactElement<{ children?: React.ReactNode }>
    const relabelled = <Paragraph key={paragraph.key ?? 'p'}>{labelTaskCheckbox(paragraph.props.children, labelId)}</Paragraph>
    return [...nodes.slice(0, looseIndex), relabelled, ...nodes.slice(looseIndex + 1)]
  }
  const blockIndex = nodes.findIndex(
    (node) => React.isValidElement(node) && (node.type === UnorderedList || node.type === OrderedList)
  )
  if (blockIndex === -1) return labelTaskCheckbox(nodes, labelId)
  return [...labelTaskCheckbox(nodes.slice(0, blockIndex), labelId), ...nodes.slice(blockIndex)]
}

const components: Components = {
  // Security review: a relative or protocol-relative href (e.g. `/C:/Windows/System32/x.exe`,
  // `//host/share/x.exe`) resolves against the production renderer's `file://` origin, and
  // `file:`/`mailto:`/`javascript:`/`data:`/unknown schemes can reach main's
  // `shell.openExternal` in unintended ways. By the time `href` reaches this component,
  // `markdownUrlTransform` (the `urlTransform` prop, above) has already reduced it to either a
  // safe absolute http(s) URL, an unchanged footnote `#user-content-fn...` fragment, or `''`
  // (blocked); an empty href still renders as plain text here (not an <a> at all).
  a: ({ node: _node, href, children, className, ...props }) => {
    // Quality-gate fix (Code Medium, round 2): hoisted above both early returns (rules of
    // hooks -- a hook call must never follow a conditional return in the same component).
    const streaming = React.useContext(StreamingContext)
    const isFootnoteAnchor = 'data-footnote-ref' in props || 'data-footnote-backref' in props
    if (isFootnoteAnchor) {
      return (
        <a {...props} href={href} className={cn('underline underline-offset-2', className)}>
          {children}
        </a>
      )
    }
    if (!href) return <>{children}</>
    // Quality-gate fix (Code/Verif Medium, round 2): everything this renders is wrapped in
    // `InsideLinkContext` so a nested inline-code URL/path (`code` below) never becomes a SECOND
    // interactive control inside this one.
    const content = <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    // Issue #610, decision 6: inert (plain underlined text, no `<a>` at all -- unfocusable, not
    // merely visually disabled) while the owning message is still streaming, so a URL cut off
    // mid-generation is never followed and no focusable element appears inside the live
    // `role="log"` region mid-stream. Footnote anchors above are exempt: they are same-page
    // fragments, never reaching `openExternal`, so the "don't follow a half-written URL" risk
    // this guards against does not apply to them.
    if (streaming) {
      return <span className={cn(inertLinkClassName, className)}>{content}</span>
    }
    return (
      <ExternalLink href={href} className={cn(linkClassName, className)} {...props}>
        {content}
      </ExternalLink>
    )
  },
  // Agent-supplied images are never rendered as <img> (constitution V); the alt text becomes a
  // link to the source instead, gated by the same http(s)-only rule as `a` above.
  img: ({ alt, src }) => {
    // Quality-gate fix (A11y2 Medium, round 3): hoisted above every early return (rules of
    // hooks). The README-badge pattern `[![alt](img-url)](link-url)` wraps this renderer's own
    // output in the OUTER `a` renderer's `<ExternalLink>`, which sets `InsideLinkContext`; without
    // this check, this renderer unconditionally returned a SECOND `<ExternalLink>` (a second
    // `<a>`), nesting an anchor inside an anchor -- invalid HTML, two tab stops for one visual
    // control, and a click on the inner `<a>` bubbling up to activate the outer one too.
    const insideLink = React.useContext(InsideLinkContext)
    const streaming = React.useContext(StreamingContext)
    const safe = safeUrl(typeof src === 'string' ? src : undefined)
    if (!safe) return <>{alt || 'image'}</>
    if (insideLink) return <>{alt || safe}</>
    if (streaming) return <span className={inertLinkClassName}>{alt || safe}</span>
    return <ExternalLink href={safe} className={linkClassName}>{alt || safe}</ExternalLink>
  },
  p: Paragraph,
  ul: UnorderedList,
  ol: OrderedList,
  // Task-list items (GFM): the checkbox gets an accessible name from its own leading text via
  // `renderTaskListItemChildren`/`labelTaskCheckbox` above (an id'd <span> + `aria-labelledby`),
  // never a wrapping <label> -- see the comment on `renderTaskListItemChildren` for why.
  li: ({ className, children, ...props }) => {
    const labelId = React.useId()
    if (!(typeof className === 'string' && className.includes('task-list-item'))) {
      return (
        <li className={className} {...props}>
          {children}
        </li>
      )
    }
    return (
      <li className={className} {...props}>
        {renderTaskListItemChildren(children, labelId)}
      </li>
    )
  },
  input: TaskCheckbox,
  del: ({ className, ...props }) => <del className={cn('text-muted-foreground', className)} {...props} />,
  // GFM table: rehype-sanitize's default schema already allows `table`/`thead`/`tbody`/`tr`/
  // `th`/`td`, so the only new work is layout -- a horizontally-scrollable wrapper (tables can
  // be wider than the column) and bordered header/data cells.
  table: ({ className, ...props }) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th className={cn('border border-border bg-muted/50 px-2 py-1 font-medium', className)} {...props} />
  ),
  td: ({ className, ...props }) => <td className={cn('border border-border px-2 py-1 align-top', className)} {...props} />,
  // GFM footnotes: the default schema already allows the footnotes `<section>`, its `sr-only`
  // `<h2>`, and the backref `<a>` (same schema source as above); this only adds the divider.
  section: ({ className, ...props }) => (
    <section
      className={cn(
        typeof className === 'string' && className.includes('footnotes')
          ? 'mt-2 border-t border-border pt-2 text-xs text-muted-foreground'
          : undefined,
        className
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn('border-l-2 border-border pl-4 text-muted-foreground', className)} {...props} />
  ),
  hr: ({ className, ...props }) => <hr className={cn('border-border', className)} {...props} />,
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),
  // Unwrapped: `code` below owns the full block rendering (Shiki output, Mermaid, or the plain
  // fallback) so a fenced block never ends up double-wrapped in nested <pre> elements.
  pre: ({ children }) => <>{children}</>,
  code({ className, children, node: _node, ...props }) {
    // Quality-gate fix (Code Medium, round 2): hoisted to the top, unconditionally -- none of
    // these may follow an early return (rules of hooks).
    const streaming = React.useContext(StreamingContext)
    const insideLink = React.useContext(InsideLinkContext)
    const sessionId = React.useContext(LinkContext)
    // Quality-gate fix (Code HIGH, round 2): `raw` (BEFORE the trailing-newline strip) is what
    // decides block-vs-inline -- mdast-util-to-hast always appends exactly one `\n` to a FENCED
    // block's own text, so a one-line, unlabelled fence (` ``` `, a path, ` ``` `) still has a
    // newline in `raw` even though the already-stripped `text` (used only for rendering) does
    // not; a CommonMark code SPAN never contains one at all. Deciding `isBlock` from `text`
    // instead let exactly that one-line fence slip through as if it were inline, breaching "no
    // links inside code fences".
    const raw = String(children)
    const text = raw.replace(/\n$/, '')
    const match = /language-(\S+)/.exec(className ?? '')
    const lang = match?.[1] ?? null
    const isBlock = Boolean(match) || raw.includes('\n')
    if (!isBlock) {
      // Quality-gate fix (Code/Verif HIGH, round 2): a linked inline-code span keeps its own
      // `<code>` chip (`bg-muted`, `font-code`) as the OUTER element in every case, with the
      // link/button/inert span INSIDE it -- replacing the chip entirely (the round-1 design)
      // turned every inline-code span rendered outside a Session context (PR descriptions/
      // timeline/reviews, `SubagentPanel`), or any plain route-like string, into bare underlined
      // prose with no code styling and a misleadingly link-shaped look for something that does
      // nothing. `insideLink` (Medium, round 2) skips URL/path detection entirely when already
      // nested inside a markdown `<a>` -- never a second interactive control in there.
      if (!insideLink) {
        const trimmed = text.trim()
        // Issue #610, decision 1/4: linked only when the WHOLE span is one URL or file path --
        // never a scan of its text for a substring, and never inside a fenced block (`isBlock`
        // above already excludes those; a fence stays a boxed, inert code surface regardless).
        // Quality-gate fix (Code Low, round 2): a span with internal whitespace is never "the
        // whole span is one URL" -- `new URL` would otherwise percent-encode the spaces and
        // treat a path-with-spaces string as a (wrong) URL.
        const safe = trimmed && !/\s/.test(trimmed) ? safeUrl(trimmed) : undefined
        if (safe) {
          return (
            <code className="rounded bg-muted px-1 py-1 font-code text-[0.85em]" {...props}>
              {streaming ? (
                <span className={mutedInertLinkClassName}>{text}</span>
              ) : (
                <ExternalLink href={safe} className={mutedLinkClassName}>
                  {text}
                </ExternalLink>
              )}
            </code>
          )
        }
        // Quality-gate fix (A11y Medium, round 2): a file-link candidate is only ever attempted
        // inside a real Session context -- `FileLinkButton` itself still degrades gracefully
        // without one, but deciding it here too means text that could never become anything but
        // the plain chip below never even builds a `fileRef` for it.
        const fileRef = sessionId && trimmed ? parseFileReference(trimmed) : null
        if (fileRef) {
          return (
            <code className="rounded bg-muted px-1 py-1 font-code text-[0.85em]" {...props}>
              <FileLinkButton path={fileRef.path} display={text} muted streaming={streaming} />
            </code>
          )
        }
      }
      return (
        <code className="rounded bg-muted px-1 py-1 font-code text-[0.85em]" {...props}>
          {children}
        </code>
      )
    }
    // #558 (FR-050 exception, gate round 3): the one fence that wraps instead of scrolling (the advisor's own quoted note); no `lang` to highlight.
    if (lang === 'advisor-note') return <CodeBlock code={text} lang={null} wrap />
    if (lang === 'mermaid') return <MermaidBlock code={text} streaming={streaming} />
    return <CodeBlock code={text} lang={lang} />
  }
}

interface MarkdownProps {
  text: string
  // The owning `TranscriptItem.id` (stable per message/thinking row). The transcript
  // (`Transcript.tsx`) renders every item in a plain scrollable `<div>`, not a virtualized
  // window, so every message's Markdown is mounted in the DOM at once -- two footnotes both
  // numbered `[^1]` in two different messages would otherwise both compile to the exact same
  // `id`/href fragment (`#user-content-fn-1`), so whichever element is first in DOM order would
  // silently absorb both messages' footnote links/backlinks. `id` becomes this message's
  // `remarkRehypeOptions.clobberPrefix` (below) so every footnote id/href is namespaced per
  // message and this cannot occur.
  id: string
  // Only set for the live assistant-text/thinking rows (`TranscriptItem.streaming`); omitted
  // (false) for settled messages, including every user message, which never stream.
  streaming?: boolean
  // Overrides the wrapper's default (inherited) text colour. The two primary-prose callers
  // (user/assistant message text, docs/DESIGN.md "Chat text colour") pass `text-chat-foreground`;
  // the Thinking row's expanded text passes `text-muted-foreground` (accessibility-auditor round
  // 2: matches its own collapsed summary's level, instead of inheriting ambient `--foreground`,
  // which reads brighter than chat prose and inverted the secondary/bookkeeping hierarchy); every
  // other caller keeps the ambient `--foreground` it already inherited.
  className?: string
}

// Agent/tool text is untrusted (constitution V): react-markdown produces a hast tree, never raw
// HTML, and rehype-sanitize strips anything outside its default schema before it reaches the DOM.
// `remark-gfm` (T065) adds tables, strikethrough, task lists, and footnotes to what gets parsed;
// rehype-sanitize's default schema already allows the hast those produce (see the `components`
// comments above), so it is still called with no custom schema. `streaming` is threaded through
// `StreamingContext` (read only by the `code`/`MermaidBlock` renderer) rather than via a per-flip
// `components` map, so the rest of the component identities stay stable across the transition.
function MarkdownImpl({ text, id, streaming = false, className }: MarkdownProps) {
  // Per-message footnote-id namespace (see `MarkdownProps.id` above). `id` is a UUID (`shared/
  // model.ts`'s `TranscriptItem.id`) but is sanitized defensively rather than assumed safe, since
  // it ends up inside an `id`/href-fragment pair. This REPLACES mdast-util-to-hast's own
  // `clobberPrefix` default (`'user-content-'`) rather than extending it: the single
  // `'user-content-'` that ends up on the final id/href comes from rehype-sanitize's clobbering
  // (see `markdownUrlTransform`'s comment above), so baking it in here too would just double it
  // again. Final ids/hrefs land as `user-content-<msg>-fn-1`.
  const footnotePrefix = React.useMemo(() => `${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-`, [id])
  const remarkRehypeOptions = React.useMemo(() => ({ clobberPrefix: footnotePrefix }), [footnotePrefix])
  return (
    <StreamingContext.Provider value={streaming}>
      <div className={cn('space-y-2 text-sm leading-relaxed break-words', className)}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          remarkRehypeOptions={remarkRehypeOptions}
          rehypePlugins={[rehypeSanitize]}
          components={components}
          urlTransform={markdownUrlTransform}
        >
          {text}
        </ReactMarkdown>
      </div>
    </StreamingContext.Provider>
  )
}

// Memoised: a streamed patch re-renders only the row whose text changed, never re-parsing unchanged messages.
export const Markdown = React.memo(MarkdownImpl)
