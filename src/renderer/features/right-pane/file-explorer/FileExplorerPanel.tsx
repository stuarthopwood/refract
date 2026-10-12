// File explorer panel (spec 015): the fifth right-pane tenant. Slice 1 (T006-T010) shipped the
// shell plus a plain, click-to-expand nested list. Slice 2 (T012, T018, T020) replaces that list
// with a real WAI-ARIA treeview (role="tree"/"treeitem", roving tabindex, full keyboard nav,
// type-ahead, virtualised per the live tree's own flattened visible rows), adds git status marks
// and a "show ignored files" toggle, and adds the bottom preview split (`FilePreviewPane.tsx`).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  Code2Icon,
  CopyIcon,
  EllipsisVerticalIcon,
  EyeOffIcon,
  FileIcon,
  FileWarningIcon,
  FileX2Icon,
  FilePlus2Icon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  TriangleAlertIcon,
  type LucideIcon
} from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Switch } from '@/components/ui/switch'
import { isFocusStranded } from '@/lib/focus'
import { notify, useFileExplorerStore, useSessionsStore } from '@/state'
import type { GitStatusMark } from '../../../../shared/model'
import type { ExpandableNode } from '../../../state/file-explorer-store'
import { FilePreviewPane } from './FilePreviewPane'

interface FileExplorerPanelProps {
  /** The Session this tree follows -- no independent binding of its own (FR-004), the same
   * pattern spec 013's Subagents panel and spec 014's Side chat already use: it always reflects
   * whichever Session the chat pane currently shows. */
  sessionId: string | null
}

/** FR-010/FR-024: icon-plus-text-equivalent for each git status mark, never colour alone.
 * Reuses already-themed, already-gated tokens (`check:theme-contrast`'s own PAIRS list) instead
 * of a raw Tailwind palette colour or a brand-new CSS custom property -- `--state-working`/
 * `--state-needs-you`/`--destructive` are each already checked at 4.5:1 (or the 3:1 icon floor)
 * against `--background`, the surface every tree row renders on at rest. `added`/`untracked`
 * share `state-working`'s own green-adjacent token (both are "new to git" states); their icon,
 * not colour, is what tells them apart -- `modified` and `added`/`untracked`/`deleted` all still
 * carry their own distinct `sr-only` label regardless. */
const STATUS_MARKS: Record<GitStatusMark, { Icon: LucideIcon; className: string; label: string }> = {
  modified: { Icon: PencilIcon, className: 'text-state-needs-you', label: 'Modified' },
  added: { Icon: FilePlus2Icon, className: 'text-state-working', label: 'Added' },
  untracked: { Icon: CircleDashedIcon, className: 'text-state-working', label: 'Untracked' },
  deleted: { Icon: FileX2Icon, className: 'text-destructive', label: 'Deleted' },
  ignored: { Icon: EyeOffIcon, className: 'text-muted-foreground', label: 'Ignored' }
}

interface NodeRow {
  kind: 'node'
  node: ExpandableNode
  depth: number
  posinset: number
  setsize: number
  /** This row's own position among every OTHER node row, in flattened visible order --
   * independent of `absIndex` (this row's position in the FULL `rows` array, "more" rows
   * included), which keyboard nav never needs: Up/Down/Home/End/type-ahead all skip "more" rows
   * entirely (nothing to select there), so they only ever need to walk this narrower sequence. */
  nodeIndex: number
}

interface MoreRow {
  kind: 'more'
  depth: number
  count: number
  key: string
}

type FlatRow = NodeRow | MoreRow

/** Flattens `root`'s currently-EXPANDED subtree into the rows the tree actually renders (T012):
 * a collapsed folder's own children are not in this array at all. `showIgnored`-filters out any
 * `ignored`-marked row (and, with it, that row's own subtree, if it is a folder) before indexing
 * siblings for `aria-posinset`/`aria-setsize`, so a hidden row never shows up in either count.
 * Each folder's own "N more" row (its own `truncated` count) is appended immediately after that
 * folder's own listed children (and their own nested rows), at the same depth as those children
 * -- matching where the capped listing itself stops. */
function flattenVisible(root: ExpandableNode | null, showIgnored: boolean): FlatRow[] {
  if (!root?.children) return []
  const rows: FlatRow[] = []
  let nodeCounter = 0
  function walk(nodes: ExpandableNode[], depth: number, parentPath: string, truncatedHere: number | undefined): void {
    const visible = nodes.filter((node) => showIgnored || node.gitStatus !== 'ignored')
    visible.forEach((node, i) => {
      rows.push({ kind: 'node', node, depth, posinset: i + 1, setsize: visible.length, nodeIndex: nodeCounter })
      nodeCounter += 1
      if (node.kind === 'folder' && node.expanded && node.children) {
        walk(node.children, depth + 1, node.path, node.truncated)
      }
    })
    if (truncatedHere) {
      rows.push({ kind: 'more', depth, count: truncatedHere, key: `more:${parentPath}` })
    }
  }
  walk(root.children, 0, root.path, root.truncated)
  return rows
}

/** Spec 015 Slice 3 (contracts/ipc.md `fileExplorer.copyPath`): joins `relativePath`'s own
 * POSIX-`/`-separated segments (`FileTreeNode.path`'s convention) onto `worktreePath`'s own
 * OS-native separator, for the renderer-side `navigator.clipboard.writeText` attempt only
 * (`useWorktreeActions.ts`'s own clipboard-first pattern) -- never the security boundary
 * itself, which stays server-side (`resolveInWorktree`, `fileExplorer.copyPath`'s own handler). */
function joinWorktreePath(worktreePath: string, relativePath: string): string {
  const separator = worktreePath.includes('\\') ? '\\' : '/'
  const trimmedRoot = worktreePath.replace(/[\\/]+$/, '')
  return `${trimmedRoot}${separator}${relativePath.split('/').join(separator)}`
}

export function FileExplorerPanel({ sessionId }: FileExplorerPanelProps) {
  const root = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.root ?? null) : null))
  const status = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.status ?? 'loading') : 'loading'))
  const error = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.error ?? null) : null))
  const showIgnored = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.showIgnored ?? false) : false))
  const selectedPath = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.selectedPath ?? null) : null))
  const preview = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.preview ?? null) : null))
  const previewLoading = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.previewLoading ?? false) : false))
  const loadDirectory = useFileExplorerStore((s) => s.loadDirectory)
  const toggleExpanded = useFileExplorerStore((s) => s.toggleExpanded)
  const setShowIgnored = useFileExplorerStore((s) => s.setShowIgnored)
  const setSelectedPath = useFileExplorerStore((s) => s.setSelectedPath)
  const loadPreview = useFileExplorerStore((s) => s.loadPreview)
  const worktreePath = useSessionsStore((s) =>
    sessionId ? s.sessions.find((session) => session.id === sessionId)?.worktreePath : undefined
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Type-ahead buffer (T012, FR-022): resets 500ms after the last keypress, same timeout
  // convention as a native `<select>`'s own type-ahead. A ref, not state -- it drives no render
  // of its own, only the NEXT keypress's search.
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>({ buffer: '', timer: undefined })
  // Tracks whether focus is currently somewhere inside this panel, kept live via a document-wide
  // `focusin` listener -- NOT read at the moment `sessionId`/`status` changes: by the time this
  // component re-renders for a Session switch or a Retry, the row/button that had focus may
  // already be mid-unmount, and a removed element's forced blur reads as `<body>`, not this
  // panel. Copies `ChatPane.tsx`'s own `chatHadFocusRef` pattern exactly (PR #671 gate fix,
  // accessibility-auditor/code-reviewer MEDIUM, round 2).
  const hadFocusRef = useRef(false)
  useEffect(() => {
    const updateFocusFlag = () => {
      hadFocusRef.current = !!containerRef.current?.contains(document.activeElement)
    }
    updateFocusFlag()
    document.addEventListener('focusin', updateFocusFlag)
    return () => document.removeEventListener('focusin', updateFocusFlag)
  }, [])

  // FR-004/FR-005: the root listing, once per Session per app run (mirrors side-chat's own
  // `loadHistory`-on-first-open effect, spec 014). Only the very first attempt is automatic --
  // once a Session has EITHER succeeded or failed once, this effect never fires again for it;
  // a failed load's own Retry button (below) is the only way to try again.
  useEffect(() => {
    if (!sessionId || useFileExplorerStore.getState().bySession[sessionId]) return
    void loadDirectory(sessionId, '')
  }, [sessionId, loadDirectory])

  // Reclaims focus onto the container ONLY when it is actually stranded -- never
  // unconditionally, which would steal focus from somewhere the user deliberately moved it to
  // (the sidebar row just clicked) even on a render where `hadFocusRef` never got a chance to
  // update first. Keyed on `[sessionId, status]`, not just `sessionId`: a Retry (same Session,
  // `status` flips `loading` -> `error` -> `ready`) unmounts the Retry button exactly the same
  // way a Session switch unmounts a focused row, and needs the identical rescue (PR #671 gate
  // fix, accessibility-auditor/code-reviewer MEDIUM, round 2). Slice 2: the same rescue now also
  // covers a preview-pane toggle (Source/Wrap) unmounting when `preview.kind` changes, since both
  // live under this one `containerRef`.
  useEffect(() => {
    if (!hadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (isFocusStranded(active, containerRef.current)) containerRef.current?.focus()
    })
  }, [sessionId, status])

  const rows = useMemo(() => flattenVisible(root, showIgnored), [root, showIgnored])
  const nodeAbsIndices = useMemo(() => {
    const indices: number[] = []
    rows.forEach((row, i) => {
      if (row.kind === 'node') indices.push(i)
    })
    return indices
  }, [rows])
  const selectedNodeIndex = useMemo(() => {
    if (nodeAbsIndices.length === 0) return -1
    const found = nodeAbsIndices.findIndex((absIndex) => (rows[absIndex] as NodeRow).node.path === selectedPath)
    return found === -1 ? 0 : found
  }, [rows, nodeAbsIndices, selectedPath])

  function activateRow(node: ExpandableNode): void {
    if (!sessionId) return
    if (node.kind === 'folder') {
      if (node.children === undefined) {
        // First expand: fetch, which also sets `expanded: true` on success (store's own
        // `withChildrenAt`).
        void loadDirectory(sessionId, node.path)
      } else {
        // Already fetched (collapsing or re-expanding): flip the local flag only, never re-fetch.
        toggleExpanded(sessionId, node.path)
      }
    } else if (node.kind === 'file') {
      void loadPreview(sessionId, node.path)
    }
    // `cannot-access`: nothing to activate.
  }

  function selectAndActivate(node: ExpandableNode): void {
    if (!sessionId) return
    setSelectedPath(sessionId, node.path)
    activateRow(node)
  }

  async function handleOpenInVSCode(path: string): Promise<boolean> {
    if (!sessionId) return true
    const result = await window.refract.fileExplorer.openInVSCode(sessionId, path)
    if (!result.ok) {
      notify(result.error)
      return true
    }
    // `{ opened: false }` is a normal result (FR-017, contracts/ipc.md), never an IPC error --
    // `TreeNodeRow` shows the "VS Code not found" state inline, never a toast.
    return result.value.opened
  }

  async function handleReveal(path: string): Promise<void> {
    if (!sessionId) return
    const result = await window.refract.fileExplorer.reveal(sessionId, path)
    if (!result.ok) notify(result.error)
  }

  // Mirrors `useWorktreeActions.ts`'s own clipboard-first-then-IPC-fallback pattern, scoped to
  // one file's own absolute path instead of the whole worktree root.
  async function handleCopyPath(path: string): Promise<void> {
    if (!sessionId) return
    if (worktreePath) {
      try {
        await navigator.clipboard.writeText(joinWorktreePath(worktreePath, path))
        toast.success('Path copied')
        return
      } catch {
        // fall through to the main-process clipboard channel
      }
    }
    const result = await window.refract.fileExplorer.copyPath(sessionId, path)
    if (result.ok) toast.success('Path copied')
    else notify(result.error)
  }

  function moveToRow(row: NodeRow, absIndex: number): void {
    if (!sessionId) return
    setSelectedPath(sessionId, row.node.path)
    virtuosoRef.current?.scrollIntoView({
      index: absIndex,
      done: () => {
        treeContainerRef.current?.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(row.node.path)}"]`)?.focus()
      }
    })
  }

  function handleTypeahead(char: string, row: NodeRow): void {
    clearTimeout(typeaheadRef.current.timer)
    typeaheadRef.current.buffer += char.toLowerCase()
    const buffer = typeaheadRef.current.buffer
    typeaheadRef.current.timer = setTimeout(() => {
      typeaheadRef.current.buffer = ''
    }, 500)
    const total = nodeAbsIndices.length
    for (let offset = 1; offset <= total; offset += 1) {
      const candidateNodeIndex = (row.nodeIndex + offset) % total
      const candidateAbsIndex = nodeAbsIndices[candidateNodeIndex]
      const candidate = candidateAbsIndex === undefined ? undefined : rows[candidateAbsIndex]
      if (candidate && candidate.kind === 'node' && candidate.node.name.toLowerCase().startsWith(buffer)) {
        moveToRow(candidate, candidateAbsIndex!)
        return
      }
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: NodeRow, absIndex: number): void {
    const node = row.node
    switch (event.key) {
      case 'ArrowRight': {
        event.preventDefault()
        if (node.kind !== 'folder') break
        if (!node.expanded) {
          activateRow(node)
          break
        }
        const childRow = rows[absIndex + 1]
        if (childRow && childRow.kind === 'node' && childRow.depth === row.depth + 1) {
          moveToRow(childRow, absIndex + 1)
        }
        break
      }
      case 'ArrowLeft': {
        event.preventDefault()
        if (node.kind === 'folder' && node.expanded) {
          activateRow(node)
          break
        }
        for (let i = absIndex - 1; i >= 0; i -= 1) {
          const candidate = rows[i]
          if (!candidate) break
          if (candidate.depth < row.depth) {
            if (candidate.kind === 'node') moveToRow(candidate, i)
            break
          }
        }
        break
      }
      case 'ArrowDown': {
        event.preventDefault()
        const nextAbs = nodeAbsIndices[row.nodeIndex + 1]
        if (nextAbs !== undefined) moveToRow(rows[nextAbs] as NodeRow, nextAbs)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        const prevAbs = nodeAbsIndices[row.nodeIndex - 1]
        if (prevAbs !== undefined) moveToRow(rows[prevAbs] as NodeRow, prevAbs)
        break
      }
      case 'Home': {
        event.preventDefault()
        const firstAbs = nodeAbsIndices[0]
        if (firstAbs !== undefined) moveToRow(rows[firstAbs] as NodeRow, firstAbs)
        break
      }
      case 'End': {
        event.preventDefault()
        const lastAbs = nodeAbsIndices[nodeAbsIndices.length - 1]
        if (lastAbs !== undefined) moveToRow(rows[lastAbs] as NodeRow, lastAbs)
        break
      }
      case 'Enter': {
        event.preventDefault()
        selectAndActivate(node)
        break
      }
      default: {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handleTypeahead(event.key, row)
        }
      }
    }
  }

  function handleRetry(): void {
    if (!sessionId) return
    // PR #671 gate fix (code-reviewer MEDIUM, round 2): focuses the container BEFORE the fetch
    // starts, not after -- the Retry button just clicked is about to unmount the instant
    // `status` flips to `'loading'` (`loadDirectory`'s own synchronous `set` call, before its
    // first `await`), and waiting for the reclaim effect above means one extra animation frame
    // where focus already reads as `<body>` to anything checking synchronously.
    containerRef.current?.focus()
    void loadDirectory(sessionId, '')
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-label="File explorer"
      className="flex h-full flex-col overflow-hidden p-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {!sessionId ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No Session open</EmptyTitle>
            <EmptyDescription>Open a Session to browse its files.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : status === 'loading' ? (
        <p role="status" className="p-2 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : status === 'error' ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Couldn't load this Session's files</EmptyTitle>
            <EmptyDescription role="alert">{error}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={handleRetry}>
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : !root?.children || root.children.length === 0 ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Empty worktree</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="no-drag-region flex shrink-0 items-center justify-between gap-2 border-b border-divider px-1 pb-1.5">
            <label htmlFor="file-explorer-show-ignored" className="text-xs text-muted-foreground">
              Show ignored files
            </label>
            <Switch
              id="file-explorer-show-ignored"
              checked={showIgnored}
              onCheckedChange={(checked) => sessionId && setShowIgnored(sessionId, checked)}
            />
          </div>
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="60%" minSize="20%">
              {rows.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  Every entry here is ignored. Turn on "Show ignored files" above to see them.
                </p>
              ) : (
                <div ref={treeContainerRef} role="tree" aria-label="Files" className="h-full">
                  <Virtuoso
                    ref={virtuosoRef}
                    style={{ height: '100%' }}
                    data={rows}
                    computeItemKey={(_index, row) => (row.kind === 'node' ? row.node.path : row.key)}
                    itemContent={(absIndex, row) =>
                      row.kind === 'more' ? (
                        <div style={{ paddingLeft: `${row.depth * 16 + 4}px` }} className="px-1 py-0.5 text-xs text-muted-foreground">
                          {row.count} more…
                        </div>
                      ) : (
                        <TreeNodeRow
                          row={row}
                          absIndex={absIndex}
                          selected={row.nodeIndex === selectedNodeIndex}
                          onRowClick={selectAndActivate}
                          onRowFocus={(node) => sessionId && setSelectedPath(sessionId, node.path)}
                          onRowKeyDown={handleRowKeyDown}
                          onOpenInVSCode={handleOpenInVSCode}
                          onReveal={handleReveal}
                          onCopyPath={handleCopyPath}
                        />
                      )
                    }
                  />
                </div>
              )}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="40%" minSize="15%">
              <FilePreviewPane
                preview={preview}
                previewLoading={previewLoading}
                onOpenInVSCode={handleOpenInVSCode}
                onReveal={handleReveal}
                onCopyPath={handleCopyPath}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </>
      )}
    </div>
  )
}

function TreeNodeRow({
  row,
  absIndex,
  selected,
  onRowClick,
  onRowFocus,
  onRowKeyDown,
  onOpenInVSCode,
  onReveal,
  onCopyPath
}: {
  row: NodeRow
  absIndex: number
  selected: boolean
  onRowClick: (node: ExpandableNode) => void
  onRowFocus: (node: ExpandableNode) => void
  onRowKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: NodeRow, absIndex: number) => void
  onOpenInVSCode: (path: string) => Promise<boolean>
  onReveal: (path: string) => Promise<void>
  onCopyPath: (path: string) => Promise<void>
}) {
  const node = row.node
  const isFolder = node.kind === 'folder'
  const expanded = node.expanded === true
  const mark = node.gitStatus ? STATUS_MARKS[node.gitStatus] : null
  // T025: a file/folder row's own 3 actions (Open in VS Code, Reveal in File Explorer, Copy
  // path) -- never offered for a `cannot-access` row, which has nothing safe to open/reveal/
  // copy (main could not even resolve it).
  const canAct = node.kind !== 'cannot-access'
  const rowRef = useRef<HTMLDivElement>(null)
  // FR-017: `{ opened: false }` is a normal result, not an IPC error (contracts/ipc.md), so this
  // shows inline rather than as a toast -- auto-clears after a few seconds or on the next
  // attempt, the same transient-but-non-toast treatment `ManageAccountsDialog.tsx`'s own
  // "GitHub CLI not found" state uses.
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])

  async function runOpenInVSCode(): Promise<void> {
    const opened = await onOpenInVSCode(node.path)
    setVscodeNotFound(!opened)
  }

  // Overrides Radix's own default close-auto-focus (which would return focus to whichever
  // element triggered the menu -- the kebab button for `DropdownMenuContent`, invisible at rest
  // since it only shows on hover/focus-within) -- this row is the roving-tabindex stop that
  // must hold focus afterward, the same reasoning `SessionList.tsx`'s own override documents.
  function handleMenuCloseAutoFocus(event: Event): void {
    event.preventDefault()
    rowRef.current?.focus()
  }

  const menuActions: Array<{ key: string; label: string; icon: LucideIcon; onSelect: () => void }> = [
    { key: 'open-vscode', label: 'Open in VS Code', icon: Code2Icon, onSelect: () => void runOpenInVSCode() },
    { key: 'reveal', label: 'Reveal in File Explorer', icon: FolderOpenIcon, onSelect: () => void onReveal(node.path) },
    { key: 'copy-path', label: 'Copy path', icon: CopyIcon, onSelect: () => void onCopyPath(node.path) }
  ]

  const rowContent = (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-selected={selected}
      aria-expanded={isFolder ? expanded : undefined}
      tabIndex={selected ? 0 : -1}
      data-tree-row-path={node.path}
      style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
      className="group no-drag-region flex w-full cursor-default items-center gap-1 rounded px-1 py-0.5 text-left text-sm outline-none hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent aria-selected:text-accent-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]"
      onClick={() => onRowClick(node)}
      onFocus={() => onRowFocus(node)}
      onKeyDown={(event) => onRowKeyDown(event, row, absIndex)}
    >
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
        {isFolder && (expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />)}
      </span>
      {isFolder ? (
        expanded ? (
          <FolderOpenIcon aria-hidden className="size-4 shrink-0" />
        ) : (
          <FolderIcon aria-hidden className="size-4 shrink-0" />
        )
      ) : node.kind === 'cannot-access' ? (
        <FileWarningIcon aria-hidden className="size-4 shrink-0" />
      ) : (
        <FileIcon aria-hidden className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate" title={node.name}>
        {node.name}
        {node.kind === 'cannot-access' && <span className="sr-only"> (cannot access)</span>}
      </span>
      {mark && (
        <span className="flex shrink-0 items-center">
          <mark.Icon aria-hidden className={`size-3 ${mark.className}`} />
          <span className="sr-only">{mark.label}</span>
        </span>
      )}
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      {canAct && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`More actions for ${node.name}`}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
              // The whole row (not a separate open button, unlike `SessionList.tsx`) carries
              // `onClick`/`onRowClick` above -- without this, clicking the trigger would bubble
              // up and also select/activate the row underneath it.
              onClick={(event) => event.stopPropagation()}
            >
              <EllipsisVerticalIcon aria-hidden className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={handleMenuCloseAutoFocus}>
            {menuActions.map((action) => (
              <DropdownMenuItem key={action.key} onSelect={action.onSelect}>
                <action.icon aria-hidden className="size-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )

  if (!canAct) return rowContent

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
        {menuActions.map((action) => (
          <ContextMenuItem key={action.key} onSelect={action.onSelect}>
            <action.icon aria-hidden className="size-3.5" />
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
