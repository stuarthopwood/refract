import * as React from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from 'cn'
import type { Highlighter } from 'shiki'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { MermaidConfig } from 'mermaid'
import { safeUrl } from '@/lib/safe-url'

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
    themes: ['github-dark', 'github-light'],
    langs: [],
    engine: createJavaScriptRegexEngine()
  })
  return highlighterPromise
}

// Tracks `.dark` on <html> (toggled in main.tsx / the later Settings theme switch) so code
// blocks repaint with the matching Shiki theme.
function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = React.useState(() => document.documentElement.classList.contains('dark'))
  React.useEffect(() => {
    const target = document.documentElement
    const observer = new MutationObserver(() => setIsDark(target.classList.contains('dark')))
    observer.observe(target, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return isDark
}

// Small header shown above every code block -- a markdown fence, and (via ToolRow's own
// language inference) a tool call's Arguments/Output (T083, FR-049/FR-050): the language's name
// when it is both known and actually highlighted, else "text" -- including when `lang` was given
// but Shiki failed to load or highlight it (the plain-fallback branch below), so the header never
// claims a highlight the body does not show. Meets WCAG AA contrast in the app's current
// dark-only theme (docs/DESIGN.md "Look and feel": "dark only, Stuart ... I don't think I want a
// light mode"); same `bg-muted`/`text-muted-foreground` pairing as `DiffView`'s own path header --
// unverified for a future light theme.
function CodeBlockHeader({ label }: { label: string }) {
  return <div className="truncate border-b border-border bg-muted px-2.5 py-1 font-code text-xs text-muted-foreground">{label}</div>
}

// The one shared code-block renderer (T083, FR-049/FR-050), exported for `ToolRow.tsx`'s
// Arguments/Output blocks. Always full width (FR-049, no copy button per FR-050/FR-042).
export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const isDark = useIsDarkTheme()
  const [html, setHtml] = React.useState<string | null>(null)

  React.useEffect(() => {
    setHtml(null)
    if (!lang) return
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
        setHtml(highlighter.codeToHtml(code, { lang, theme: isDark ? 'github-dark' : 'github-light' }))
      } catch {
        if (!cancelled) setHtml(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, lang, isDark])

  const label = html ? lang! : 'text'
  // Named for a screen reader and keyboard-reachable on its own (the block's content is never
  // otherwise focusable): a sighted keyboard user who tabs to a wide block needs to know it is
  // its own horizontally-scrolling region, not stuck reading the outer wrapper's clipped edge.
  const regionLabel = `${label} code block`
  // `focus-visible:ring-inset` draws the ring *inside* the scrollable element's own box instead of
  // outside it, so the outer wrapper's `overflow-hidden` (needed to clip the body to the header's
  // rounded corners) can never clip the ring off on the left/right/bottom.
  const scrollableClassName = 'overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

  if (html) {
    // Shiki's own HTML output (highlighted spans only, no agent text interpreted as markup),
    // per the constitution's markdown/sanitisation rule.
    return (
      <div className="not-prose max-w-none overflow-hidden rounded-lg border border-border text-xs">
        <CodeBlockHeader label={label} />
        <div
          tabIndex={0}
          role="region"
          aria-label={regionLabel}
          className={cn(scrollableClassName, '[&>pre]:m-0 [&>pre]:p-3')}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }
  return (
    <div className="not-prose max-w-none overflow-hidden rounded-lg border border-border text-xs">
      <CodeBlockHeader label={label} />
      <pre tabIndex={0} role="region" aria-label={regionLabel} className={cn(scrollableClassName, 'bg-card p-3')}>
        <code>{code}</code>
      </pre>
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
  const isDark = useIsDarkTheme()
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
          theme: isDark ? 'dark' : 'default'
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
  }, [code, isDark, streaming, reactId])

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
      <button
        type="button"
        aria-expanded={showSource}
        aria-controls={sourceId}
        onClick={() => setShowSource((value) => !value)}
        className="-mx-1 px-1 py-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {showSource ? `Hide source for ${accessibleName}` : `Show source for ${accessibleName}`}
      </button>
      <div id={sourceId} hidden={!showSource}>
        <CodeBlock code={code} lang="mermaid" />
      </div>
    </div>
  )
}

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ className, ...props }: React.ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag className={cn('font-semibold', className)} {...props} />
  }
}

// `code` reads the surface's `streaming` flag from `StreamingContext` (T066: draw a Mermaid
// fence only once the reply has stopped streaming) rather than closing over it, so this map is a
// static module-level object built once -- rebuilding it per `streaming` flip previously gave
// every component (a, p, table, code, ...) a new function identity on each flip, forcing React to
// unmount and remount the whole markdown subtree (and every CodeBlock's Shiki-highlighted state
// with it) the moment a streaming reply finished.
const StreamingContext = React.createContext(false)

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
          : 'list-disc pl-5',
        className
      )}
      {...props}
    />
  )
}
function OrderedList({ className, ...props }: React.ComponentProps<'ol'> & ExtraProps) {
  return <ol className={cn('list-decimal pl-5', className)} {...props} />
}
// Task-list checkboxes (GFM): rehype-sanitize's default (GitHub-style) schema already allows
// `input[type=checkbox][disabled]` and `li.task-list-item` (hast-util-sanitize
// lib/schema.js), so no schema extension was needed for T065; this only themes the checkbox.
function TaskCheckbox({ className, ...props }: React.ComponentProps<'input'> & ExtraProps) {
  return <input className={cn('mr-1.5 align-middle accent-primary', className)} {...props} />
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
    const isFootnoteAnchor = 'data-footnote-ref' in props || 'data-footnote-backref' in props
    if (isFootnoteAnchor) {
      return (
        <a {...props} href={href} className={cn('underline underline-offset-2', className)}>
          {children}
        </a>
      )
    }
    if (!href) return <>{children}</>
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={cn('underline underline-offset-2', className)}
      >
        {children}
      </a>
    )
  },
  // Agent-supplied images are never rendered as <img> (constitution V); the alt text becomes a
  // link to the source instead, gated by the same http(s)-only rule as `a` above.
  img: ({ alt, src }) => {
    const safe = safeUrl(typeof src === 'string' ? src : undefined)
    if (!safe) return <>{alt || 'image'}</>
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
        {alt || safe}
      </a>
    )
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
    <th className={cn('border border-border bg-muted/50 px-2 py-1 font-semibold', className)} {...props} />
  ),
  td: ({ className, ...props }) => <td className={cn('border border-border px-2 py-1 align-top', className)} {...props} />,
  // GFM footnotes: the default schema already allows the footnotes `<section>`, its `sr-only`
  // `<h2>`, and the backref `<a>` (same schema source as above); this only adds the divider.
  section: ({ className, ...props }) => (
    <section
      className={cn(
        typeof className === 'string' && className.includes('footnotes')
          ? 'mt-3 border-t border-border pt-2 text-xs text-muted-foreground'
          : undefined,
        className
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn('border-l-2 border-border pl-3 text-muted-foreground', className)} {...props} />
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
    const streaming = React.useContext(StreamingContext)
    const text = String(children).replace(/\n$/, '')
    const match = /language-(\S+)/.exec(className ?? '')
    const lang = match?.[1] ?? null
    const isBlock = Boolean(match) || text.includes('\n')
    if (!isBlock) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-code text-[0.85em]" {...props}>
          {children}
        </code>
      )
    }
    if (lang === 'mermaid') {
      return <MermaidBlock code={text} streaming={streaming} />
    }
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
  // Overrides the wrapper's default (inherited) text colour. Only the two primary-prose callers
  // (user/assistant message text, docs/DESIGN.md "Chat text colour") pass `text-chat-foreground`;
  // every other caller (thinking, ask-question text, ...) renders secondary/bookkeeping material
  // and keeps the ambient `--foreground` it already inherited.
  className?: string
}

// Agent/tool text is untrusted (constitution V): react-markdown produces a hast tree, never raw
// HTML, and rehype-sanitize strips anything outside its default schema before it reaches the DOM.
// `remark-gfm` (T065) adds tables, strikethrough, task lists, and footnotes to what gets parsed;
// rehype-sanitize's default schema already allows the hast those produce (see the `components`
// comments above), so it is still called with no custom schema. `streaming` is threaded through
// `StreamingContext` (read only by the `code`/`MermaidBlock` renderer) rather than via a per-flip
// `components` map, so the rest of the component identities stay stable across the transition.
export function Markdown({ text, id, streaming = false, className }: MarkdownProps) {
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
