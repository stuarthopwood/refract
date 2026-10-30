import * as React from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { REVEAL_ACTION_LABEL, RevealActionIcon, revealActionName } from '@/components/revealAction'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@/lib/utils'
import type { Highlighter } from 'shiki'
import { getHighlighter, highlightToHtml } from './shikiHighlighter'
import type { MermaidConfig } from 'mermaid'
import { safeUrl } from '@/lib/safe-url'
import { parseFileReference, looksWithinWorktree } from '@/lib/linkify'
import { THEMES } from '../../../shared/themes'
import { MERMAID_THEME_VARIABLES, getMermaidThemeCSS } from '../../../shared/mermaidTheme'
import { toast } from 'sonner'
import { useActiveThemeId, useSessionsStore } from '@/state'
import { CopyButton } from '@/components/ui/copy-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { linkClassName, mutedLinkClassName } from './linkStyles'
import { LinkActions } from './LinkActions'
import {
  MarkdownBlockquote,
  MarkdownOptionsContext,
  MarkdownTable,
  MarkdownTd,
  MarkdownTh,
  ResolvedImage
} from './markdownExtras'
import { OrderedList, Paragraph, TaskCheckbox, UnorderedList, renderTaskListItemChildren } from './markdownLists'

// Runs on every href/src before `components` renderers, so the relative-href block must live here.
// GFM footnote anchors are same-page fragments and pass through; everything else goes via `safeUrl`.
// `Markdown` sets a per-message `clobberPrefix` (so messages never collide on `#user-content-fn-1`),
// but rehype-sanitize also prepends `user-content-` to every `id` and never to `href`; re-add it
// to the fragment so the footnote link still resolves.
function markdownUrlTransform(value: string, _key: string, node: { properties?: Record<string, unknown> }): string {
  const properties = node.properties ?? {}
  const isFootnoteAnchor = 'dataFootnoteRef' in properties || 'dataFootnoteBackref' in properties
  if (isFootnoteAnchor && value.startsWith('#')) return `#user-content-${value.slice(1)}`
  return safeUrl(value) ?? ''
}

// Header above every code block: the language when known and highlighted, else "text", so it never
// claims a highlight the body lacks. `copyText` is the full value to copy (a caller may show a
// truncated body, #524); the Copy button is always visible, hidden when empty so it never clears
// the clipboard, and its label names the language so blocks are distinguishable to a screen reader.
function CodeBlockHeader({ label, copyText, hideCopy = false }: { label: string; copyText: string; hideCopy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-code-block px-2 py-1 font-code text-xs text-muted-foreground">
      <span className="truncate text-md-code-label">{label}</span>
      {copyText !== '' && !hideCopy && (
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

// Above this size `CodeBlock` skips Shiki: its synchronous `codeToHtml` froze the renderer (#671).
const MAX_HIGHLIGHT_BYTES = 200 * 1024
/** The shared code-block renderer; every block's header carries a Copy button (#524). */
export function CodeBlock({
  code,
  lang,
  wrap = false,
  lineNumbers = false,
  copyText,
  hideCopy = false,
}: {
  code: string
  lang: string | null
  // True when the caller owns a single Copy control elsewhere (the tool dialog's section header).
  hideCopy?: boolean
  // Wrap for prose-shaped surfaces; other callers (fences, tool output, ASCII diagrams) scroll sideways.
  wrap?: boolean
  // Opt-in line-number gutter, one row per source line for both highlighted and plain paths. It is
  // not rendered while `wrap` is on, since wrapped lines would misalign the numbers.
  lineNumbers?: boolean
  // What Copy puts on the clipboard when it differs from the visible `code` (#524); defaults to `code`.
  copyText?: string
}) {
  const activeThemeId = useActiveThemeId()
  const [html, setHtml] = React.useState<string | null>(null)

  React.useEffect(() => {
    setHtml(null)
    // `codeToHtml` is synchronous (2.1 MB took 10.7s, freezing the whole renderer), so oversized
    // code takes the instant plain-<pre> fallback instead.
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
        // #975/#456: the body shares `bg-code-block` with the header/gutter; `highlightToHtml` neutralises Shiki's own root background.
        const syntaxTheme = THEMES[activeThemeId].syntaxTheme
        setHtml(highlightToHtml(highlighter, code, lang, syntaxTheme))
      } catch {
        if (!cancelled) setHtml(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, lang, activeThemeId])

  const label = html ? lang! : 'text'
  // Named and keyboard-reachable so a wide block is its own scrollable region.
  const regionLabel = `${label} code block`
  // `ring-inset` keeps the ring inside the box, where the wrapper's `overflow-hidden` can't clip it.
  const scrollableClassName = 'overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
  // Applies regardless of `lang`/`html`: FilePreviewPane's Wrap toggle passes real languages, which render highlighted.
  const wrapClassName = 'whitespace-pre-wrap break-words outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
  const showLineNumbers = lineNumbers && !wrap
  const lineCount = showLineNumbers ? code.split('\n').length : 0

  // One text node, not a <div> per line (a ~1 MiB file would allocate 30-60k nodes); the leading
  // matches the content column so numbers line up.
  const gutter = showLineNumbers ? (
    <pre
      aria-hidden
      className="m-0 select-none border-r border-border bg-code-block py-4 pl-4 pr-2 text-right leading-[1.6] text-muted-foreground tabular-nums"
    >
      {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
    </pre>
  ) : null

  if (html) {
    // Shiki's own output (highlighted spans only; no agent text interpreted as markup).
    return (
      <div className="not-prose max-w-none overflow-hidden rounded-lg border border-border text-xs">
        <CodeBlockHeader label={label} copyText={copyText ?? code} hideCopy={hideCopy} />
        <div className="flex">
          {gutter}
          <div
            tabIndex={0}
            role="region"
            aria-label={regionLabel}
            className={cn(
              'min-w-0 flex-1 bg-code-block',
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
      <CodeBlockHeader label={label} copyText={copyText ?? code} hideCopy={hideCopy} />
      <div className="flex">
        {gutter}
        <pre
          tabIndex={0}
          role="region"
          aria-label={regionLabel}
          className={cn('min-w-0 flex-1', wrap ? wrapClassName : scrollableClassName, 'bg-code-block p-4 leading-[1.6]')}
        >
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

// A unified diff's hunk/file markers.
const DIFF_PATTERN = /^(?:---|\+\+\+) |^@@ -|^diff --git /m

/** Infers a code surface's language: `diff` for a unified diff, pretty-printed `json` when it parses, else plain text. */
export function inferOutputBlock(text: string): { lang: string | null; code: string } {
  if (DIFF_PATTERN.test(text)) return { lang: 'diff', code: text }
  try {
    return { lang: 'json', code: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { lang: null, code: text }
  }
}

// Mermaid loads lazily on first use. `securityLevel: 'strict'` and `secure` stop a `%%{init}%%`
// directive in agent source loosening them (docs/spike/FINDINGS.md). `render()` briefly appends a
// temp node to `document.body`, so safety rests on the pinned version, strict mode and DOMPurify;
// the result is an inert `data:image/svg+xml` <img> and `bindFunctions` is never called.
const MERMAID_MAX_SOURCE_BYTES = 50_000
const MERMAID_RENDER_TIMEOUT_MS = 5_000

let mermaidPromise: Promise<typeof import('mermaid')> | null = null
function getMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid')
  return mermaidPromise
}

// Fallback accessible names for Mermaid's `diagramType` when the source has no `accTitle`.
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

// Reads `accTitle`/`accDescr` back out of the SVG's `<title>`/`<desc>` (an <img> hides them) via an
// inert DOMParser, to expose as the image's accessible name/description (FR-043).
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
    // Draw only once streaming stops (an in-progress fence is incomplete, not invalid). Keep the
    // last-good `result` mounted across re-renders so focus never drops to <body> from Show-source.
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
          // Patches Mermaid CSS gaps `themeVariables` can't reach (see `getMermaidThemeCSS`).
          themeCSS: getMermaidThemeCSS(activeThemeId)
        } satisfies MermaidConfig)
        const rendered = await Promise.race([
          mermaid.render(`mermaid-${reactId}`, code),
          new Promise<never>((_resolve, reject) => {
            // Only guards slow async resolution: `mermaid.render()` can't be interrupted mid-layout.
            // The CPU bound is the size cap above plus Mermaid's `maxEdges` (FINDINGS item 26).
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
    return <Tag className={cn('font-bold', (Tag === 'h1' || Tag === 'h2' || Tag === 'h3') && 'text-md-heading', className)} {...props} />
  }
}

// `code` reads `streaming` from context so this map stays a static module-level object; rebuilding
// it per flip remounted the whole markdown subtree (and every CodeBlock's highlight) on finish.
const StreamingContext = React.createContext(false)

/** The owning Session's id (#610), provided by `Transcript.tsx`; `null` makes `FileLinkButton` fall back to plain text. */
export const LinkContext = React.createContext<string | null>(null)

// True inside a markdown `<a>`, so a nested link/file-link never becomes a second interactive element.
const InsideLinkContext = React.createContext(false)

// Shared class for link-shaped controls: accent text with a permanent underline (never colour
// alone, WCAG 1.4.1), contrast-gated by check-theme-contrast.mjs. Lives in `./linkStyles.ts` so
// `InlineDisclosure` can reuse it without an import cycle; re-exported for existing callers.
export { linkClassName, mutedLinkClassName }

// The streaming-inert state can't be activated, so it carries no hover/focus classes.
const inertLinkClassName = 'text-accent-text underline underline-offset-2 [overflow-wrap:anywhere]'
const mutedInertLinkClassName = 'underline underline-offset-2 [overflow-wrap:anywhere]'

// Every web link gets a tooltip naming the real destination (hover and focus), the mitigation for
// a link whose text and destination differ (#610). `aria-describedby`, never `aria-label`, so the
// visible text stays the accessible name (WCAG 2.5.3).
interface ExternalLinkProps extends Omit<React.ComponentPropsWithoutRef<'a'>, 'href' | 'className' | 'children'> {
  href: string
  className: string
  children: React.ReactNode
  wrapLink?: (link: React.ReactNode) => React.ReactNode
}

function ExternalLink({ href, className, children, wrapLink, title: _title, ...rest }: ExternalLinkProps) {
  // A markdown `title` is agent-written and could show a fake destination in the native tooltip
  // over our real one, so it is discarded and never reaches the `<a>`.
  const describedById = React.useId()
  // The URL object's canonical form (punycode host, bidi/zero-width characters percent-encoded),
  // so a homograph host or RTL-override path can't spoof the tooltip; `<bdi dir="ltr">` below
  // guards any bidi character that survived.
  const shown = new URL(href).href
  const anchorRef = React.useRef<HTMLAnchorElement>(null)
  return (
    <LinkActions
      copyText={shown}
      copyLabel="Copy link"
      copiedMessage="Link copied"
      wrapLink={wrapLink}
      // Activating the anchor itself reuses the one external-link policy (tauri-bridge/externalLinks.ts).
      actions={[{ label: 'Open in browser', icon: ExternalLinkIcon, onSelect: () => anchorRef.current?.click() }]}
    >
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          {...rest}
          ref={anchorRef}
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
      {/* `hidden`, not `sr-only`: still read via aria-describedby but kept out of copy/paste selection. */}
      <span id={describedById} hidden>
        Open in browser: <bdi dir="ltr">{shown}</bdi>
      </span>
    </Tooltip>
    </LinkActions>
  )
}

interface FileLinkButtonProps {
  /** The bare path sent to `sessions.revealFile`; never a `:line[:col]` suffix (#463). */
  path: string
  /** Visible text and tooltip label; defaults to `path`. */
  display?: string
  /** `true` on a `bg-muted` surface (inline code, `DiffView`'s header) -- see `mutedLinkClassName`. */
  muted?: boolean
  /** Inert while the owning message streams, so a half-generated path is never followed. */
  streaming?: boolean
  /** Layout-only; merged onto whichever branch renders. */
  className?: string
  /** Layout-only: forwarded to the link wrapper (`LinkActions`) when the link renders as a control, e.g. `DiffView`'s flex header. */
  wrapperClassName?: string
  /** Wraps just the link, e.g. in an inline-code chip, so the Copy slot sits outside the chip. */
  wrapLink?: (link: React.ReactNode) => React.ReactNode
}

/** The app-wide file-link control. "Show in File Explorer", never "Open": a default-verb open could execute an agent-written `.cmd`/`.ps1`/`.lnk`. */
export function FileLinkButton({ path, display, muted = false, streaming = false, className, wrapperClassName, wrapLink }: FileLinkButtonProps) {
  const sessionId = React.useContext(LinkContext)
  const worktreePath = useSessionsStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.worktreePath : undefined
  )
  const label = display ?? path
  // String-only early-out, not the security boundary (`resolveInWorktree` checks on click).
  const withinWorktree = worktreePath === undefined || looksWithinWorktree(path, worktreePath)

  // Outside a Session or the worktree: plain text, never a link-styled span that does nothing.
  if (!sessionId || !withinWorktree) {
    const plain = (
      <span className={className} title={label}>
        {label}
      </span>
    )
    return wrapLink ? <>{wrapLink(plain)}</> : plain
  }

  if (streaming) {
    const inert = (
      <span className={cn(muted ? mutedInertLinkClassName : inertLinkClassName, className)} title={label}>
        {label}
      </span>
    )
    return wrapLink ? <>{wrapLink(inert)}</> : inert
  }

  const activeClassName = muted ? mutedLinkClassName : linkClassName
  const reveal = (): void => {
    void window.refract.sessions.revealFile(sessionId, path).then((result) => {
      // Dismiss-until-cleared: a stale/wrong file reference needs a moment to read (round 3).
      if (!result.ok) toast.error(result.error.message, { duration: Infinity, closeButton: true })
    })
  }
  return (
    <LinkActions
      copyText={path}
      copyLabel="Copy path"
      copiedMessage="Path copied"
      wrapperClassName={wrapperClassName}
      wrapLink={wrapLink}
      actions={[{ label: REVEAL_ACTION_LABEL, icon: RevealActionIcon, onSelect: reveal }]}
    >
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(activeClassName, className)}
          aria-label={revealActionName(label)}
          // Blocks Radix's own `aria-describedby` so the tooltip isn't announced on top of the aria-label.
          aria-describedby={undefined}
          onClick={reveal}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="[overflow-wrap:anywhere]">
        {revealActionName(label)}
      </TooltipContent>
    </Tooltip>
    </LinkActions>
  )
}

const components: Components = {
  // `markdownUrlTransform` has already reduced `href` to an absolute http(s) URL, a footnote
  // fragment or `''` (blocked: relative/`file:`/`javascript:` hrefs must never reach `openExternal`).
  a: ({ node: _node, href, children, className, ...props }) => {
    // Hoisted above the early returns (rules of hooks).
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
    const content = <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    // Inert while streaming so a half-written URL is never followed or focusable in the live log (#610).
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
    // `[![alt](img)](link)` nests this inside the outer `<a>`; check it to avoid an anchor in an anchor.
    const insideLink = React.useContext(InsideLinkContext)
    const streaming = React.useContext(StreamingContext)
    const { resolveImage } = React.useContext(MarkdownOptionsContext)
    const safe = safeUrl(typeof src === 'string' ? src : undefined)
    if (!safe) return <>{alt || 'image'}</>
    if (insideLink) return <>{alt || safe}</>
    if (streaming) return <span className={inertLinkClassName}>{alt || safe}</span>
    const link = <ExternalLink href={safe} className={linkClassName}>{alt || safe}</ExternalLink>
    // Only a caller that passes `resolveImage` (the Pull requests view) ever fetches an image; the link above is also its loading/failure fallback.
    if (resolveImage) return <ResolvedImage src={safe} alt={alt ?? ''} resolveImage={resolveImage} fallback={link} />
    return link
  },
  p: Paragraph,
  ul: UnorderedList,
  ol: OrderedList,
  // Task-list checkbox is named via `renderTaskListItemChildren`, never a wrapping <label>.
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
  table: MarkdownTable,
  th: MarkdownTh,
  td: MarkdownTd,
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
  blockquote: MarkdownBlockquote,
  hr: ({ className, ...props }) => <hr className={cn('border-border', className)} {...props} />,
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),
  // Unwrapped: `code` owns block rendering, avoiding nested <pre>.
  pre: ({ children }) => <>{children}</>,
  code({ className, children, node: _node, ...props }) {
    const streaming = React.useContext(StreamingContext)
    const insideLink = React.useContext(InsideLinkContext)
    const sessionId = React.useContext(LinkContext)
    // Block-vs-inline is decided from `raw` (pre newline-strip): a fence always ends in `\n`, a code span never does.
    const raw = String(children)
    const text = raw.replace(/\n$/, '')
    const match = /language-(\S+)/.exec(className ?? '')
    const lang = match?.[1] ?? null
    const isBlock = Boolean(match) || raw.includes('\n')
    if (!isBlock) {
      // The `<code>` chip stays the outer element; a link goes inside it. Skipped inside an `<a>`.
      if (!insideLink) {
        const trimmed = text.trim()
        // Linked only when the whole span is one URL/path (#610); whitespace would be percent-encoded by `new URL`.
        const safe = trimmed && !/\s/.test(trimmed) ? safeUrl(trimmed) : undefined
        const chip = (inner: React.ReactNode): React.ReactNode => (
          <code className="rounded bg-md-code-bg px-1 py-1 font-code text-code-inline text-md-code-fg" {...props}>
            {inner}
          </code>
        )
        if (safe) {
          return streaming ? (
            chip(<span className={mutedInertLinkClassName}>{text}</span>)
          ) : (
            <ExternalLink href={safe} className={mutedLinkClassName} wrapLink={chip}>
              {text}
            </ExternalLink>
          )
        }
        const fileRef = sessionId && trimmed ? parseFileReference(trimmed) : null
        if (fileRef) {
          return <FileLinkButton path={fileRef.path} display={text} muted streaming={streaming} wrapLink={chip} />
        }
      }
      return (
        <code className="rounded bg-md-code-bg px-1 py-1 font-code text-code-inline text-md-code-fg" {...props}>
          {children}
        </code>
      )
    }
    // The advisor's quoted note wraps instead of scrolling (#558).
    if (lang === 'advisor-note') return <CodeBlock code={text} lang={null} wrap />
    if (lang === 'mermaid') return <MermaidBlock code={text} streaming={streaming} />
    return <CodeBlock code={text} lang={lang} />
  }
}

interface MarkdownProps {
  text: string
  // The `TranscriptItem.id`; namespaces footnote ids (`clobberPrefix`) since all messages mount at once.
  id: string
  // True only for the live assistant-text/thinking rows.
  streaming?: boolean
  // Overrides the inherited text colour.
  className?: string
  // Pull requests view only: GitHub-style tables.
  githubStyle?: boolean
  // Pull requests view only: resolves an image URL to a `data:` URL; omitted means images stay alt-text links.
  resolveImage?: (url: string) => Promise<string | null>
}

// Agent/tool text is untrusted: react-markdown yields a hast tree (never raw HTML) and
// rehype-sanitize strips anything outside its default schema. `streaming` goes via context so
// `components` stays static.
function MarkdownImpl({ text, id, streaming = false, className, githubStyle = false, resolveImage }: MarkdownProps) {
  // Replaces (not extends) mdast's default `clobberPrefix`: rehype-sanitize already adds `user-content-`.
  const footnotePrefix = React.useMemo(() => `${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-`, [id])
  const remarkRehypeOptions = React.useMemo(() => ({ clobberPrefix: footnotePrefix }), [footnotePrefix])
  const options = React.useMemo(() => ({ githubStyle, resolveImage }), [githubStyle, resolveImage])
  return (
    <StreamingContext.Provider value={streaming}>
      <MarkdownOptionsContext.Provider value={options}>
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
      </MarkdownOptionsContext.Provider>
    </StreamingContext.Provider>
  )
}

// Memoised: a streamed patch re-renders only the row whose text changed, never re-parsing unchanged messages.
export const Markdown = React.memo(MarkdownImpl)
