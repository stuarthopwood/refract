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

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
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

  if (html) {
    // Shiki's own HTML output (highlighted spans only, no agent text interpreted as markup),
    // per the constitution's markdown/sanitisation rule.
    return (
      <div
        className="not-prose max-w-none overflow-x-auto rounded-lg border border-border text-xs [&>pre]:m-0 [&>pre]:p-3"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <pre className="not-prose max-w-none overflow-x-auto rounded-lg border border-border bg-card p-3 text-xs">
      <code>{code}</code>
    </pre>
  )
}

// Mermaid is loaded lazily (dynamic `import()`) only once the first ```mermaid fence actually
// appears, so it never adds to the main bundle (T066). `securityLevel: 'strict'` is mermaid's
// default and, per its own docs (config/schema-docs/config-properties-securitylevel.html),
// disables click callbacks and encodes HTML in labels; `secure` additionally defaults to
// `['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']`
// (config-properties-secure.html), so a `%%{init}%%` directive in agent-authored diagram source
// cannot override `securityLevel` back to `'loose'` -- confirmed live in docs/spike/FINDINGS.md.
// The rendered SVG is never inserted into the DOM directly: it is shown as an inert
// `data:image/svg+xml` <img>, which disables script execution entirely regardless of
// `securityLevel` (MDN "SVG as an image": "JavaScript is disabled" in image contexts), so
// `bindFunctions` (mermaid's click-handler attacher) is intentionally never called.
const MERMAID_MAX_SOURCE_BYTES = 50_000
const MERMAID_RENDER_TIMEOUT_MS = 5_000

let mermaidPromise: Promise<typeof import('mermaid')> | null = null
function getMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid')
  return mermaidPromise
}

function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const isDark = useIsDarkTheme()
  const [showSource, setShowSource] = React.useState(false)
  const [result, setResult] = React.useState<{ svg: string; diagramType: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const reactId = React.useId().replace(/:/g, '-')

  React.useEffect(() => {
    setResult(null)
    setError(null)
    // Only draw once the reply has stopped streaming: an in-progress fence is incomplete
    // diagram source, not invalid diagram source, so showing the raw block (not a failure
    // reason) while `streaming` is true is the correct fallback (T066).
    if (streaming) return
    const byteLength = new TextEncoder().encode(code).length
    if (byteLength > MERMAID_MAX_SOURCE_BYTES) {
      setError(`source is ${Math.round(byteLength / 1000)} KB, over the ${MERMAID_MAX_SOURCE_BYTES / 1000} KB cap`)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const mermaid = (await getMermaid()).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark ? 'dark' : 'default'
        } satisfies MermaidConfig)
        const rendered = await Promise.race([
          mermaid.render(`mermaid-${reactId}`, code),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('render timed out after 5s')), MERMAID_RENDER_TIMEOUT_MS)
          })
        ])
        if (cancelled) return
        setResult({ svg: rendered.svg, diagramType: rendered.diagramType })
      } catch (err) {
        if (!cancelled) setError((err instanceof Error ? err.message : String(err)).slice(0, 200))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, isDark, streaming, reactId])

  if (streaming) {
    return <CodeBlock code={code} lang="mermaid" />
  }
  if (error) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Diagram failed to render: {error}</p>
        <CodeBlock code={code} lang="mermaid" />
      </div>
    )
  }
  if (!result) {
    return <CodeBlock code={code} lang="mermaid" />
  }
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`
  return (
    <div className="space-y-1">
      <img
        src={dataUrl}
        role="img"
        aria-label={`Mermaid ${result.diagramType} diagram`}
        className="max-w-full rounded-lg border border-border bg-card p-2"
      />
      <button
        type="button"
        onClick={() => setShowSource((value) => !value)}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {showSource ? 'Hide source' : 'Show source'}
      </button>
      {showSource && <CodeBlock code={code} lang="mermaid" />}
    </div>
  )
}

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ className, ...props }: React.ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag className={cn('font-semibold', className)} {...props} />
  }
}

// Built per render (not a module constant) because `code` needs the surface's `streaming` flag
// (T066: draw a Mermaid fence only once the reply has stopped streaming); everything else is
// static and only re-allocates when `streaming` flips, via the `useMemo` in `Markdown` below.
function buildComponents(streaming: boolean): Components {
  return {
    // Security review: a relative or protocol-relative href (e.g. `/C:/Windows/System32/x.exe`,
    // `//host/share/x.exe`) resolves against the production renderer's `file://` origin, and
    // `file:`/`mailto:`/`javascript:`/`data:`/unknown schemes can reach main's
    // `shell.openExternal` in unintended ways. Only an absolute http(s) URL is ever rendered as a
    // clickable link; anything else renders as plain text (not an <a> at all, not just one
    // without an href), so `urlTransform` alone (which can only blank a property) is not enough.
    // GFM footnote back/forward references are same-page `#...` anchors, so they fall under this
    // same relative-href rule and render as plain (non-clickable) text, never as a loophole.
    a: ({ node: _node, href, children, ...props }) => {
      const safe = safeUrl(href)
      if (!safe) return <>{children}</>
      return (
        <a {...props} href={safe} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
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
    p: ({ className, ...props }) => <p className={className} {...props} />,
    // `contains-task-list` (added by remark-gfm's tasklist handling) drops the bullet marker and
    // tightens spacing so the checkbox sits where the bullet would; an ordinary list keeps the
    // existing disc/decimal marker.
    ul: ({ className, ...props }) => (
      <ul
        className={cn(
          typeof className === 'string' && className.includes('contains-task-list')
            ? 'list-none space-y-1 pl-0'
            : 'list-disc pl-5',
          className
        )}
        {...props}
      />
    ),
    ol: ({ className, ...props }) => <ol className={cn('list-decimal pl-5', className)} {...props} />,
    // Task-list checkboxes (GFM): rehype-sanitize's default (GitHub-style) schema already allows
    // `input[type=checkbox][disabled]` and `li.task-list-item` (hast-util-sanitize
    // lib/schema.js), so no schema extension was needed for T065; this only themes the checkbox.
    input: ({ className, ...props }) => <input className={cn('mr-1.5 align-middle accent-primary', className)} {...props} />,
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
}

interface MarkdownProps {
  text: string
  // Only set for the live assistant-text/thinking rows (`TranscriptItem.streaming`); omitted
  // (false) for settled messages, including every user message, which never stream.
  streaming?: boolean
}

// Agent/tool text is untrusted (constitution V): react-markdown produces a hast tree, never raw
// HTML, and rehype-sanitize strips anything outside its default schema before it reaches the DOM.
// `remark-gfm` (T065) adds tables, strikethrough, task lists, and footnotes to what gets parsed;
// rehype-sanitize's default schema already allows the hast those produce (see the `components`
// comments above), so it is still called with no custom schema.
export function Markdown({ text, streaming = false }: MarkdownProps) {
  const components = React.useMemo(() => buildComponents(streaming), [streaming])
  return (
    <div className="space-y-2 text-sm leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components} urlTransform={safeUrl}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
