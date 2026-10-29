// Spec 015 Slice 2 (T020) / Slice 3 (T025): the preview region for the File explorer's bottom
// split pane (FR-012 to FR-015, FR-021, FR-023), plus the preview-toolbar's own Open in VS Code/
// Reveal in File Explorer/Copy path button group (T025) -- the same three actions
// `TreeNodeRow`'s own context menu offers, duplicated here per tasks.md's own explicit wording
// ("a preview-toolbar button group offering" the same three) rather than folded away as
// redundant, since the preview pane is reachable without ever opening the tree row's menu.
// `FileExplorerPanel.tsx` still owns the Session/store wiring and the three handler functions
// themselves -- this stays a presentational component, just no longer prop-free for them.
import { useEffect, useState } from 'react'
import { FileIcon, FileWarningIcon, TriangleAlertIcon, WrapTextIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { CodeBlock, Markdown } from '@/features/chat/Markdown'
import { formatByteSize } from '@/features/chat/attachments'
import type { FilePreview } from '../../../../shared/model'
import { PathActionButtons, type PathActionHandlers } from './path-actions'

interface FilePreviewPaneProps {
  preview: FilePreview | null
  previewLoading: boolean
  onOpenInVSCode: (path: string) => Promise<boolean>
  onReveal: (path: string) => Promise<void>
  onCopyPath: (path: string, confirm?: boolean) => Promise<boolean>
}

/** Last path segment, `FileTreeNode.path`'s own POSIX-`/`-separated convention -- never a raw
 * OS-separator split, since every path this component ever sees came straight from main's own
 * `FileTreeNode`/`FilePreview` shapes. */
function fileName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

// T020: `CodeBlock` gained an opt-in `lineNumbers` prop (PR #671 gate round 4 fix, High, FR-012)
// specifically for this caller -- every other `CodeBlock` caller in the app keeps its own exact
// rendering (`lineNumbers` defaults `false`). Not exhaustive -- common source extensions only,
// matching Shiki's own bundled grammar ids; an unrecognised extension (or none) falls back to
// `null`, which `CodeBlock` already renders as plain, unhighlighted text rather than failing.
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

export function FilePreviewPane({ preview, previewLoading, onOpenInVSCode, onReveal, onCopyPath }: FilePreviewPaneProps) {
  const [wrap, setWrap] = useState(false)
  const [showSource, setShowSource] = useState(false)
  // PR #671 gate round 4 fix (Medium, Code4): the previous comment here CLAIMED a reset already
  // happened ("a local reset inside the two toggle handlers") -- it did not; `useState(false)`
  // only ever runs its initializer ONCE, on this component's first mount, so a Wrap/Source toggle
  // left on from one file carried straight over to the next, regardless of file kind. An effect
  // keyed on the selected file's own path resets both on every real selection change, without
  // remounting the whole pane (which a `key={preview?.path}` approach would have forced, dropping
  // focus on every single click).
  useEffect(() => {
    setWrap(false)
    setShowSource(false)
  }, [preview?.path])
  // Same transient, non-toast "VS Code not found" treatment `TreeNodeRow`'s own context menu
  // uses (FR-017) -- this call site is independent of that one's own state, since the two
  // triggers (a tree row's menu vs this toolbar) can fire for different files/moments.
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])

  const regionLabel = preview ? `Preview of ${fileName(preview.path)}` : 'File preview'
  // T025: offered for any EXISTING file (every kind except `'deleted'`, which has nothing left
  // to open/reveal/copy) -- including `binary`/`too-large`/`read-error`, whose content cannot
  // render here but whose path is still perfectly actionable. Hidden while a new selection is
  // still loading, so these three actions never fire against a stale `preview.path` left over
  // from the PREVIOUS selection mid-fetch.

  // The header stays mounted while a new selection loads (actions disabled), so the row never
  // flickers and the actions never fire against a stale `preview.path`. Hidden for no selection
  // and for a deleted file, which has nothing to open/reveal/copy.
  const showHeader = previewLoading || (!!preview && preview.kind !== 'deleted')
  const actionsDisabled = previewLoading || !preview
  const path = preview?.path ?? ''

  async function runOpenInVSCode(): Promise<void> {
    const opened = await onOpenInVSCode(path)
    setVscodeNotFound(!opened)
  }

  const handlers: PathActionHandlers = {
    openInVSCode: () => void runOpenInVSCode(),
    reveal: () => void onReveal(path),
    copyPath: (confirm) => onCopyPath(path, confirm)
  }

  // FR-023: the content is always the one labelled, keyboard-scrollable region, reachable by Tab
  // from the tree, regardless of what is currently showing inside it -- `tabIndex={0}` rather than
  // relying on a scrollable-region-with-no-focusable-descendant implicitly becoming tabbable,
  // since several of the states below (the image, the empty states) have no focusable
  // descendant of their own to fall back on. The header sits OUTSIDE that scroll region, one
  // fixed single row (ghost buttons, no divider; #756 amendment 2026-10-21).
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
          <PathActionButtons handlers={handlers} disabled={actionsDisabled} />
          {preview?.kind === 'markdown' && (
            // `aria-pressed` alone carries the toggle state: the accessible name stays constant ("Source"), never flipping with its own pressed state (gate remediation, Medium).
            <Button type="button" variant="ghost" size="sm" className="shrink-0" disabled={previewLoading} aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
              Source
            </Button>
          )}
          {preview?.kind === 'text' && (
            <Button type="button" variant="ghost" size="sm" className="shrink-0" disabled={previewLoading} aria-pressed={wrap} aria-label="Wrap long lines" onClick={() => setWrap((v) => !v)}>
              <WrapTextIcon aria-hidden className="size-4" />
              Wrap
            </Button>
          )}
        </div>
      )}
      <div
        role="region"
        aria-label={regionLabel}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
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
      ) : preview.kind === 'read-error' ? (
        // PR #671 gate round 4 fix (Medium, Code4/Sec4): `readPreview`'s own TOCTOU fix (fs.open/
        // stat/read on one handle) now distinguishes "gone" (ENOENT, handled by the `'deleted'`
        // branch above) from "exists but couldn't be read" (EACCES/EBUSY -- an agent has it open
        // for writing, a permissions problem) -- these need their own, different message: the
        // file is still there, nothing was "removed or renamed".
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
          {showSource ? (
            <CodeBlock code={preview.content ?? ''} lang="markdown" wrap={wrap} lineNumbers />
          ) : (
            <Markdown text={preview.content ?? ''} id={preview.path} />
          )}
        </div>
      ) : (
        // `kind: 'text'` (every other preview kind is handled above).
        <div className="flex flex-col gap-2">
          <CodeBlock code={preview.content ?? ''} lang={guessLangFromPath(preview.path)} wrap={wrap} lineNumbers />
        </div>
      )}
      </div>
    </div>
  )
}
