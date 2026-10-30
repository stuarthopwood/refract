import * as React from 'react'
import type { MermaidConfig } from 'mermaid'
import { DownloadIcon, FileCodeIcon, ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { actionMenuItem, menuSeparator } from '@/features/palette/menuItems'
import { notify, useActiveThemeId } from '@/state'
import { MERMAID_THEME_VARIABLES, getMermaidThemeCSS } from '../../../shared/mermaidTheme'
import { CodeBlock } from './CodeBlock'
import { copyLinkText } from './linkClipboard'
import { svgToPngBase64 } from './mermaidImage'
import { TranscriptMenu } from './TranscriptMenu'

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function diagramPng(svg: string, image: HTMLImageElement | null): Promise<string> {
  const background = image ? getComputedStyle(image).backgroundColor : '#ffffff'
  return svgToPngBase64(svg, background)
}

export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const activeThemeId = useActiveThemeId()
  const [showSource, setShowSource] = React.useState(false)
  const [result, setResult] = React.useState<{
    svg: string
    diagramType: string
    title: string | null
    desc: string | null
  } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)
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
        if (!cancelled) setError(errorMessage(err).slice(0, 200))
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
    return <CodeBlock code={code} lang="mermaid" streaming />
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

  const { svg } = result
  const copyImage = async (): Promise<boolean> => {
    try {
      const reply = await window.refract.clipboard.writeImage(await diagramPng(svg, imageRef.current))
      if (!reply.ok) notify(reply.error)
      return reply.ok
    } catch (err) {
      notify({ code: 'clipboard-failed', message: errorMessage(err) })
      return false
    }
  }
  const saveImage = async (): Promise<void> => {
    try {
      const reply = await window.refract.clipboard.saveImage(await diagramPng(svg, imageRef.current), 'diagram.png')
      if (!reply.ok) notify(reply.error)
      else if (reply.value) toast.success(`Image saved to ${reply.value}`)
    } catch (err) {
      notify({ code: 'clipboard-failed', message: errorMessage(err) })
    }
  }
  const copyImageWithToast = async (): Promise<void> => {
    if (await copyImage()) toast.success('Image copied')
  }

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const accessibleName = result.title || `Mermaid ${mermaidDiagramTypeLabel(result.diagramType)}`
  const describedBy = result.desc ? descId : sourceId
  const buttonClassName = 'text-muted-foreground'
  return (
    <TranscriptMenu
      className="space-y-1"
      items={(kind) => (
        <>
          {actionMenuItem('transcript.mermaid-copy-source', { kind, onSelect: () => void copyLinkText(code, 'Source copied', 'Nothing to copy: the source only contains hidden characters') })}
          {actionMenuItem('transcript.mermaid-copy-image', { kind, onSelect: () => void copyImageWithToast() })}
          {menuSeparator(kind)}
          {actionMenuItem('transcript.mermaid-save-image', { kind, onSelect: () => void saveImage() })}
        </>
      )}
    >
      <img
        ref={imageRef}
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
      <div className="flex items-center gap-1">
        <CopyButton getText={() => code} label={`Copy source for ${accessibleName}`} announcement="Source copied" icon={FileCodeIcon} className={buttonClassName} />
        <CopyButton onCopy={copyImage} label={`Copy ${accessibleName} as image`} announcement="Image copied" icon={ImageIcon} className={buttonClassName} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`Save ${accessibleName} as image`} className={buttonClassName} onClick={() => void saveImage()}>
              <DownloadIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save image</TooltipContent>
        </Tooltip>
      </div>
      <InlineDisclosure
        open={showSource}
        onOpenChange={setShowSource}
        contentId={sourceId}
        label={showSource ? `Hide source for ${accessibleName}` : `Show source for ${accessibleName}`}
      >
        <CodeBlock code={code} lang="mermaid" />
      </InlineDisclosure>
    </TranscriptMenu>
  )
}
