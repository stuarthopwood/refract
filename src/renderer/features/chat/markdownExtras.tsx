import * as React from 'react'
import type { ExtraProps } from 'react-markdown'
import { CircleAlert, Info, Lightbulb, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Per-render options for the shared `Markdown`, read by the module-level renderers below through
// context so the `components` map keeps stable function identities (see Markdown.tsx's comment on
// `StreamingContext`). Defaults reproduce the chat behaviour: no GitHub styling, never fetch images.
export interface MarkdownOptions {
  githubStyle: boolean
  resolveImage?: (url: string) => Promise<string | null>
}

export const MarkdownOptionsContext = React.createContext<MarkdownOptions>({ githubStyle: false })

type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const ALERTS: Record<AlertKind, { title: string; Icon: LucideIcon; bar: string; icon: string }> = {
  note: { title: 'Note', Icon: Info, bar: 'border-alert-note', icon: 'text-alert-note' },
  tip: { title: 'Tip', Icon: Lightbulb, bar: 'border-alert-tip', icon: 'text-alert-tip' },
  important: { title: 'Important', Icon: CircleAlert, bar: 'border-alert-important', icon: 'text-alert-important' },
  warning: { title: 'Warning', Icon: TriangleAlert, bar: 'border-alert-warning', icon: 'text-alert-warning' },
  caution: { title: 'Caution', Icon: OctagonAlert, bar: 'border-alert-caution', icon: 'text-alert-caution' }
}

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n)?/i

interface ParsedAlert {
  kind: AlertKind
  body: React.ReactNode[]
}

// A blockquote is an alert when its first paragraph's first text node starts with a marker. The
// marker is stripped; a paragraph left empty by that is dropped.
function parseAlert(children: React.ReactNode): ParsedAlert | null {
  const nodes = React.Children.toArray(children)
  const paragraphIndex = nodes.findIndex((node) => React.isValidElement(node))
  if (paragraphIndex === -1) return null
  const paragraph = nodes[paragraphIndex] as React.ReactElement<{ children?: React.ReactNode }>
  const content = React.Children.toArray(paragraph.props.children)
  const first = content[0]
  if (typeof first !== 'string') return null
  const match = ALERT_MARKER.exec(first)
  if (!match) return null
  const rest = [first.slice(match[0].length), ...content.slice(1)].filter((part) => part !== '')
  const isEmpty = rest.every((part) => typeof part === 'string' && part.trim() === '')
  const before = nodes.slice(0, paragraphIndex)
  const after = nodes.slice(paragraphIndex + 1)
  const body = isEmpty ? [...before, ...after] : [...before, React.cloneElement(paragraph, undefined, ...rest), ...after]
  return { kind: (match[1] ?? 'note').toLowerCase() as AlertKind, body }
}

export function MarkdownBlockquote({ className, children, node: _node, ...props }: React.ComponentProps<'blockquote'> & ExtraProps) {
  const alert = parseAlert(children)
  if (!alert) {
    return (
      <blockquote className={cn('border-l-2 border-border pl-4 text-muted-foreground', className)} {...props}>
        {children}
      </blockquote>
    )
  }
  const { title, Icon, bar, icon } = ALERTS[alert.kind]
  return (
    <blockquote className={cn('space-y-1 border-l-4 pl-4', bar, className)} {...props}>
      <p className="flex items-center gap-2 font-medium">
        <Icon aria-hidden="true" className={cn('size-4 shrink-0', icon)} />
        <span>{title}</span>
      </p>
      {alert.body}
    </blockquote>
  )
}

export function MarkdownTable({ className, node: _node, ...props }: React.ComponentProps<'table'> & ExtraProps) {
  const { githubStyle } = React.useContext(MarkdownOptionsContext)
  if (githubStyle) {
    return (
      <div className="overflow-x-auto">
        <table className={cn('w-max max-w-full border-collapse text-left text-sm', className)} {...props} />
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  )
}

export function MarkdownTh({ className, node: _node, ...props }: React.ComponentProps<'th'> & ExtraProps) {
  const { githubStyle } = React.useContext(MarkdownOptionsContext)
  return (
    <th
      className={cn(
        githubStyle ? 'border border-divider px-4 py-2 font-semibold' : 'border border-border bg-muted/50 px-2 py-1 font-medium',
        className
      )}
      {...props}
    />
  )
}

export function MarkdownTd({ className, node: _node, ...props }: React.ComponentProps<'td'> & ExtraProps) {
  const { githubStyle } = React.useContext(MarkdownOptionsContext)
  return <td className={cn(githubStyle ? 'border border-divider px-4 py-2 align-top' : 'border border-border px-2 py-1 align-top', className)} {...props} />
}

// Renders the resolved image; while loading, or when resolution fails, shows `fallback` (the
// existing alt-text link) so a failed fetch never leaves a hole.
export function ResolvedImage({
  src,
  alt,
  resolveImage,
  fallback
}: {
  src: string
  alt: string
  resolveImage: (url: string) => Promise<string | null>
  fallback: React.ReactNode
}) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    resolveImage(src).then(
      (resolved) => {
        if (!cancelled) setDataUrl(resolved)
      },
      () => {
        if (!cancelled) setDataUrl(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [src, resolveImage])
  if (!dataUrl) return <>{fallback}</>
  return <img src={dataUrl} alt={alt} className="inline-block max-w-full" />
}
