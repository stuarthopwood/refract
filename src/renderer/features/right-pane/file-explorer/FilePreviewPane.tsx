// Spec 015 Slice 2 (T020): the preview region for the File explorer's bottom split pane
// (FR-012 to FR-015, FR-021, FR-023). Pure presentational component -- `FileExplorerPanel.tsx`
// owns the Session/store wiring and passes `preview`/`previewLoading` straight through, the same
// "dumb child, store lives in the parent" shape the rest of this panel already follows.
import { useState } from 'react'
import { FileIcon, FileWarningIcon, TriangleAlertIcon, WrapTextIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { CodeBlock, Markdown } from '@/features/chat/Markdown'
import { formatByteSize } from '@/features/chat/attachments'
import type { FilePreview } from '../../../../shared/model'

interface FilePreviewPaneProps {
  preview: FilePreview | null
  previewLoading: boolean
}

/** Last path segment, `FileTreeNode.path`'s own POSIX-`/`-separated convention -- never a raw
 * OS-separator split, since every path this component ever sees came straight from main's own
 * `FileTreeNode`/`FilePreview` shapes. */
function fileName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

// T020: `CodeBlock` has no line-numbers option of its own (checked -- `code`/`lang`/`wrap`/
// `copyText` only) -- a plain `CodeBlock` without line numbers is the accepted fallback (brief's
// own judgment call), with this file's own wrap toggle next to it since `CodeBlock`'s `wrap` prop
// has no toggle UI of its own either. Not exhaustive -- common source extensions only, matching
// Shiki's own bundled grammar ids; an unrecognised extension (or none) falls back to `null`,
// which `CodeBlock` already renders as plain, unhighlighted text rather than failing.
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

export function FilePreviewPane({ preview, previewLoading }: FilePreviewPaneProps) {
  // Independent per selected preview, not per Session -- a Source toggle/wrap state left on from
  // a previous file would be a surprising carry-over for the next one. Reset keyed on `preview?.
  // path` below via a plain prop-driven remount would also work, but a local reset inside the two
  // toggle handlers (never flipped true for a kind that cannot show it) is simpler here and
  // avoids an extra `key` prop forcing the whole pane to remount on every selection.
  const [wrap, setWrap] = useState(false)
  const [showSource, setShowSource] = useState(false)

  const regionLabel = preview ? `Preview of ${fileName(preview.path)}` : 'File preview'

  // FR-023: always the one labelled, keyboard-scrollable region, reachable by Tab from the
  // tree, regardless of what is currently showing inside it -- `tabIndex={0}` rather than
  // relying on a scrollable-region-with-no-focusable-descendant implicitly becoming tabbable,
  // since several of the states below (the image, the empty states) have no focusable
  // descendant of their own to fall back on.
  return (
    <div
      role="region"
      aria-label={regionLabel}
      tabIndex={0}
      className="flex h-full flex-col overflow-y-auto p-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {previewLoading ? (
        <p role="status" className="p-2 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : !preview ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No file selected</EmptyTitle>
            <EmptyDescription>Select a file in the tree above to preview it.</EmptyDescription>
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
      ) : preview.kind === 'image' ? (
        <img
          src={`data:${preview.mimeType};base64,${preview.base64}`}
          alt={`Preview of ${fileName(preview.path)}`}
          className="max-h-full max-w-full self-start object-contain"
        />
      ) : preview.kind === 'markdown' ? (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end">
            {/* `aria-pressed` alone carries the toggle state -- the accessible name stays
                constant ("Source"), never flipping to a second word describing the OTHER state,
                the same fix `IconRail.tsx`'s own rail buttons already apply (gate remediation,
                Medium: a toggle's name must not change with its own pressed state). */}
            <Button type="button" variant="outline" size="sm" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
              Source
            </Button>
          </div>
          {showSource ? (
            <CodeBlock code={preview.content ?? ''} lang="markdown" wrap={wrap} />
          ) : (
            <Markdown text={preview.content ?? ''} id={preview.path} />
          )}
        </div>
      ) : (
        // `kind: 'text'` (every other preview kind is handled above).
        <div className="flex flex-col gap-2">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={wrap}
              aria-label="Wrap long lines"
              onClick={() => setWrap((v) => !v)}
            >
              <WrapTextIcon aria-hidden className="size-3.5" />
              Wrap
            </Button>
          </div>
          <CodeBlock code={preview.content ?? ''} lang={guessLangFromPath(preview.path)} wrap={wrap} />
        </div>
      )}
    </div>
  )
}
