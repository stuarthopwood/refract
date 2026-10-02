import * as React from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from 'cn'
import type { Highlighter } from 'shiki'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
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

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ className, ...props }: React.ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag className={cn('font-semibold', className)} {...props} />
  }
}

const components: Components = {
  // Security review: a relative or protocol-relative href (e.g. `/C:/Windows/System32/x.exe`,
  // `//host/share/x.exe`) resolves against the production renderer's `file://` origin, and
  // `file:`/`mailto:`/`javascript:`/`data:`/unknown schemes can reach main's
  // `shell.openExternal` in unintended ways. Only an absolute http(s) URL is ever rendered as a
  // clickable link; anything else renders as plain text (not an <a> at all, not just one
  // without an href), so `urlTransform` alone (which can only blank a property) is not enough.
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
  ul: ({ className, ...props }) => <ul className={cn('list-disc pl-5', className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn('list-decimal pl-5', className)} {...props} />,
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
  // Unwrapped: `code` below owns the full block rendering (Shiki output, or the plain fallback)
  // so a fenced block never ends up double-wrapped in nested <pre> elements.
  pre: ({ children }) => <>{children}</>,
  code({ className, children, node: _node, ...props }) {
    const text = String(children).replace(/\n$/, '')
    const match = /language-(\S+)/.exec(className ?? '')
    const isBlock = Boolean(match) || text.includes('\n')
    if (!isBlock) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-code text-[0.85em]" {...props}>
          {children}
        </code>
      )
    }
    return <CodeBlock code={text} lang={match?.[1] ?? null} />
  }
}

interface MarkdownProps {
  text: string
}

// Agent/tool text is untrusted (constitution V): react-markdown produces a hast tree, never raw
// HTML, and rehype-sanitize strips anything outside its default schema before it reaches the DOM.
// The default schema already keeps `className` on `code` (needed for the `language-xxx` class),
// so no extended schema is needed.
export function Markdown({ text }: MarkdownProps) {
  return (
    <div className="space-y-2 text-sm leading-relaxed break-words">
      <ReactMarkdown rehypePlugins={[rehypeSanitize]} components={components} urlTransform={safeUrl}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
