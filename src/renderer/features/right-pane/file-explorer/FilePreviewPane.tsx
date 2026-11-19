// A file tab's preview: header with Open in VS Code/Reveal/Copy path, Wrap and Source toggles, then the content. Wrap, Source and
// scroll are the tab's own state, owned by the document store; `FileTabView` wires them and the handlers.
import { useEffect, useState } from 'react'
import { FileIcon, FileWarningIcon, TriangleAlertIcon, WrapTextIcon } from 'lucide-react'
import { InlineStatus } from '@/components/InlineStatus'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { CodeBlock, Markdown } from '@/features/chat/Markdown'
import { formatByteSize } from '@/features/chat/attachments'
import type { FilePreview } from '../../../../shared/model'
import { useScrollMemory } from '@/features/documents/useScrollMemory'
import { PathActionButtons, type PathActionHandlers } from './path-actions'

interface FilePreviewPaneProps {
  /** The tab's own path, so the header and actions stay right while a first load has no preview yet. */
  path: string
  preview: FilePreview | null
  previewLoading: boolean
  wrap: boolean
  showSource: boolean
  scrollTop: number | undefined
  onWrapChange: (wrap: boolean) => void
  onSourceChange: (source: boolean) => void
  onScrollTopChange: (scrollTop: number) => void
  onOpenInVSCode: (path: string) => Promise<boolean>
  onReveal: (path: string) => Promise<void>
  onCopyPath: (path: string, confirm?: boolean) => Promise<boolean>
}

/** Last path segment of a POSIX-`/`-separated `FileTreeNode.path`; never split on the OS separator. */
function fileName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

// Common source extensions only, matching Shiki's grammar ids; an unrecognised one maps to `null` (plain text).
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  sql: 'sql',
  graphql: 'graphql',
  lua: 'lua',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'mdx',
  dockerfile: 'dockerfile',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff'
}

function guessLangFromPath(path: string): string | null {
  const name = fileName(path)
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  return EXTENSION_LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null
}

const PREVIEW_KIND_LABELS: Record<'binary' | 'too-large', string> = {
  binary: 'Binary file',
  'too-large': 'File too large'
}

export function FilePreviewPane({
  path,
  preview,
  previewLoading,
  wrap,
  showSource,
  scrollTop,
  onWrapChange,
  onSourceChange,
  onScrollTopChange,
  onOpenInVSCode,
  onReveal,
  onCopyPath
}: FilePreviewPaneProps) {
  // Same transient "VS Code not found" treatment as the tree row menu, with independent state.
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])
  const scroll = useScrollMemory<HTMLDivElement>(preview !== null, scrollTop, onScrollTopChange)

  // A refresh keeps the last content on screen, so only a first load has nothing to show.
  const firstLoad = previewLoading && !preview
  // The header stays for every state but a deleted file, where there is nothing left to open.
  const showHeader = preview?.kind !== 'deleted'

  async function runOpenInVSCode(): Promise<void> {
    const opened = await onOpenInVSCode(path)
    setVscodeNotFound(!opened)
  }

  const handlers: PathActionHandlers = {
    openInVSCode: () => void runOpenInVSCode(),
    reveal: () => void onReveal(path),
    copyPath: (confirm) => onCopyPath(path, confirm)
  }

  // The shell's tabpanel is the one landmark; the header sits outside the scroller as one fixed row (#756).
  return (
    <div className="flex h-full flex-col">
      {showHeader && (
        <div className="no-drag-region flex shrink-0 flex-nowrap items-center gap-1 px-2 pt-2">
          <span title={path} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {fileName(path)}
          </span>
          {vscodeNotFound && (
            <span role="status" className="shrink-0 text-xs text-muted-foreground">
              VS Code not found
            </span>
          )}
          <PathActionButtons handlers={handlers} disabled={firstLoad} />
          {preview?.kind === 'markdown' && (
            // `aria-pressed` alone carries the toggle state; the accessible name stays "Source".
            <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-pressed={showSource} onClick={() => onSourceChange(!showSource)}>
              Source
            </Button>
          )}
          {preview?.kind === 'text' && (
            <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-pressed={wrap} aria-label="Wrap long lines" onClick={() => onWrapChange(!wrap)}>
              <WrapTextIcon aria-hidden className="size-4" />
              Wrap
            </Button>
          )}
        </div>
      )}
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {firstLoad ? (
          <InlineStatus tone="loading">Loading…</InlineStatus>
        ) : !preview ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>Couldn't load this file</EmptyTitle>
              <EmptyDescription>Switch to another tab and back to try again.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : preview.kind === 'deleted' ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlertIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>This file no longer exists</EmptyTitle>
              <EmptyDescription role="alert">{fileName(preview.path)} was removed or renamed.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : preview.kind === 'binary' || preview.kind === 'too-large' ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileWarningIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>Can't preview this file</EmptyTitle>
              <EmptyDescription>
                {PREVIEW_KIND_LABELS[preview.kind]}
                {preview.size !== undefined ? `, ${formatByteSize(preview.size)}` : ''}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : preview.kind === 'read-error' ? (
          // Exists but unreadable (EACCES/EBUSY), unlike `'deleted'`: the file is still there.
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlertIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>Couldn't read this file</EmptyTitle>
              <EmptyDescription>It may be open in another program, or you may not have permission to read it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : preview.kind === 'image' ? (
          <img
            src={`data:${preview.mimeType};base64,${preview.base64}`}
            alt={`Preview of ${fileName(preview.path)}`}
            className="max-h-full max-w-full self-start object-contain"
          />
        ) : preview.kind === 'markdown' ? (
          <div className="flex flex-col gap-2">
            {showSource ? <CodeBlock code={preview.content ?? ''} lang="markdown" wrap={wrap} hideWrap lineNumbers /> : <Markdown text={preview.content ?? ''} id={preview.path} />}
          </div>
        ) : (
          // `kind: 'text'` (every other preview kind is handled above).
          <div className="flex flex-col gap-2">
            <CodeBlock code={preview.content ?? ''} lang={guessLangFromPath(preview.path)} wrap={wrap} hideWrap lineNumbers />
          </div>
        )}
      </div>
    </div>
  )
}
