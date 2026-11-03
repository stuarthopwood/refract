import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { FolderIcon, FolderOpenIcon, TriangleAlertIcon } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { toast } from 'sonner'
import { InlineStatus } from '@/components/InlineStatus'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Switch } from '@/components/ui/switch'
import { isFocusStranded } from '@/lib/focus'
import { notify, useFileExplorerStore, useSessionsStore } from '@/state'
import type { ExpandableNode } from '../../../state/file-explorer-store'
import { buildFolderRollup } from './git-decoration'
import { FilePreviewPane } from './FilePreviewPane'
import { TreeNodeRow, type NodeRow } from './TreeNodeRow'

interface FileExplorerPanelProps {
  sessionId: string | null
}

interface MoreRow {
  kind: 'more'
  depth: number
  count: number
  key: string
  posinset: number
  setsize: number
}

type FlatRow = NodeRow | MoreRow

// Flattens `root`'s currently-EXPANDED subtree into the rows the tree actually renders: a
// collapsed folder's own children are not in this array at all.
function flattenVisible(root: ExpandableNode | null, showIgnored: boolean): FlatRow[] {
  if (!root?.children) return []
  const rows: FlatRow[] = []
  let nodeCounter = 0
  function walk(nodes: ExpandableNode[], depth: number, parentPath: string, truncatedHere: number | undefined): void {
    const visible = nodes.filter((node) => showIgnored || node.gitStatus !== 'ignored')
    const siblingCount = visible.length + (truncatedHere ? 1 : 0)
    visible.forEach((node, i) => {
      rows.push({ kind: 'node', node, depth, posinset: i + 1, setsize: siblingCount, nodeIndex: nodeCounter })
      nodeCounter += 1
      if (node.kind === 'folder' && node.expanded && node.children) {
        walk(node.children, depth + 1, node.path, node.truncated)
      }
    })
    if (truncatedHere) {
      rows.push({ kind: 'more', depth, count: truncatedHere, key: `more:${parentPath}`, posinset: siblingCount, setsize: siblingCount })
    }
  }
  walk(root.children, 0, root.path, root.truncated)
  return rows
}

// Spec 015 Slice 3 (contracts/ipc.md `fileExplorer.copyPath`): joins `relativePath`'s own
// POSIX-`/`-separated segments (`FileTreeNode.path`'s convention) onto `worktreePath`'s own
// OS-native separator, for the renderer-side `navigator.clipboard.writeText` attempt only
// (`useWorktreeActions.ts`'s own clipboard-first pattern) -- never the security boundary itself,
// which stays server-side (`resolveInWorktree`, `fileExplorer.copyPath`'s own handler).
function joinWorktreePath(worktreePath: string, relativePath: string): string {
  const separator = worktreePath.includes('\\') ? '\\' : '/'
  const trimmedRoot = worktreePath.replace(/[\\/]+$/, '')
  return `${trimmedRoot}${separator}${relativePath.split('/').join(separator)}`
}

// `RightPaneShell.tsx` conditionally renders this component only while its tab is the ACTIVE one
// (`activePanelId === 'file-explorer' && <FileExplorerPanel.../>`) -- switching to a different tab,
// or closing the last open tab, genuinely unmounts it; switching to a DIFFERENT Session while
// staying on this tab keeps the component mounted but changes `sessionId`.
const watcherRefCounts = new Map<string, number>()

export function FileExplorerPanel({ sessionId }: FileExplorerPanelProps) {
  const root = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.root ?? null) : null))
  const hasSessionEntry = useFileExplorerStore((s) => (sessionId ? sessionId in s.bySession : false))
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
  const rowsRef = useRef<FlatRow[]>([])
  const rescueFocusRef = useRef(false)
  // A ref, not state -- it drives no render of its own, only the NEXT keypress's search.
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>({ buffer: '', timer: undefined })
  // The `querySelector(...)?.focus` call then silently finds nothing and does nothing, stranding
  // focus on `<body>` after a key the TREE ITSELF handles -- not the separate, disclosed
  // mouse-wheel/resize scroll-out limitation elsewhere in this file, since no further user action
  // caused this one.
  const moveGenRef = useRef(0)
  const pendingFocusPathRef = useRef<string | null>(null)
  // Tracks whether focus is currently somewhere inside this panel, kept live via a document-wide
  // `focusin` listener -- NOT read at the moment `sessionId`/`status` changes: by the time this
  // component re-renders for a Session switch or a Retry, the row/button that had focus may already
  // be mid-unmount, and a removed element's forced blur reads as `<body>`, not this panel.
  const hadFocusRef = useRef(false)
  useEffect(() => {
    const updateFocusFlag = () => {
      hadFocusRef.current = !!containerRef.current?.contains(document.activeElement)
    }
    updateFocusFlag()
    document.addEventListener('focusin', updateFocusFlag)
    return () => document.removeEventListener('focusin', updateFocusFlag)
  }, [])

  // Only the very first attempt is automatic -- once a Session has EITHER succeeded or failed once,
  // this effect never fires again for it; a failed load's own Retry button (below) is the only way
  // to try again.
  useEffect(() => {
    if (!sessionId || hasSessionEntry) return
    void loadDirectory(sessionId, '')
  }, [sessionId, hasSessionEntry, loadDirectory])

  // Keyed on `[sessionId]` alone, deliberately: this must re-run for a Session SWITCH while this
  // tab stays active (the component instance survives, only the prop changes) exactly the same way
  // it re-runs for a genuine mount/unmount, so the OLD Session's watcher is released and the NEW
  // one's is (re)started either way.
  useEffect(() => {
    if (!sessionId) return
    const id = sessionId
    const count = (watcherRefCounts.get(id) ?? 0) + 1
    watcherRefCounts.set(id, count)
    if (count === 1) {
      window.refract.fileExplorer
        .ensureWatching(id)
        .then((result) => {
          if (!result.ok) console.warn('FileExplorerPanel: ensureWatching failed', result.error)
        })
        .catch((err) => console.warn('FileExplorerPanel: ensureWatching rejected', err))
    }
    return () => {
      const remaining = (watcherRefCounts.get(id) ?? 1) - 1
      if (remaining <= 0) {
        watcherRefCounts.delete(id)
        window.refract.fileExplorer
          .stopWatching(id)
          .then((result) => {
            if (!result.ok) console.warn('FileExplorerPanel: stopWatching failed', result.error)
          })
          .catch((err) => console.warn('FileExplorerPanel: stopWatching rejected', err))
      } else {
        watcherRefCounts.set(id, remaining)
      }
    }
  }, [sessionId])

  // Reclaims focus onto the container ONLY when it is actually stranded -- never unconditionally,
  // which would steal focus from somewhere the user deliberately moved it to (the sidebar row just
  // clicked) even on a render where `hadFocusRef` never got a chance to update first.
  useEffect(() => {
    if (!hadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (isFocusStranded(active, containerRef.current)) containerRef.current?.focus()
      if (status === 'ready' && document.activeElement === containerRef.current) {
        const treeRow = treeContainerRef.current?.querySelector<HTMLElement>('[data-tree-row-path][tabindex="0"]')
        rescueFocusRef.current = true
        try {
          treeRow?.focus({ preventScroll: true })
        } finally {
          rescueFocusRef.current = false
        }
      }
    })
  }, [sessionId, status])

  // A document-wide `focusin` listener (like `hadFocusRef`'s own) cannot catch this case: there is
  // no NEW `focusin` event when an element is simply removed out from under focus.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    function performRescue(): void {
      const treeRow = treeContainerRef.current?.querySelector<HTMLElement>('[data-tree-row-path][tabindex="0"]')
      const anyRow = treeContainerRef.current?.querySelector<HTMLElement>('[data-tree-row-path]')
      const previewRegion = containerRef.current?.querySelector<HTMLElement>('[role="region"]')
      const target = treeRow ?? anyRow ?? previewRegion ?? containerRef.current
      rescueFocusRef.current = true
      try {
        target?.focus({ preventScroll: true })
      } finally {
        rescueFocusRef.current = false
      }
    }
    function handleFocusOut(event: FocusEvent): void {
      if (event.relatedTarget !== null) return
      const lost = event.target as Element | null
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, containerRef.current)) return
        if (lost) {
          const genuinelyGone =
            !lost.isConnected || lost.closest('[inert]') !== null || (lost as HTMLButtonElement).disabled === true
          if (!genuinelyGone) return
          const lostRowPath = lost.closest('[data-tree-row-path]')?.getAttribute('data-tree-row-path') ?? null
          if (lostRowPath !== null && rowsRef.current.some((row) => row.kind === 'node' && row.node.path === lostRowPath)) {
            return
          }
          const lostMoreKey = lost.closest('[data-tree-more-key]')?.getAttribute('data-tree-more-key') ?? null
          if (lostMoreKey !== null && rowsRef.current.some((row) => row.kind === 'more' && row.key === lostMoreKey)) {
            return
          }
        }
        performRescue()
      })
    }
    container.addEventListener('focusout', handleFocusOut)
    return () => {
      container.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  const rows = useMemo(() => flattenVisible(root, showIgnored), [root, showIgnored])
  const gitStatusMap = useFileExplorerStore((s) => (sessionId ? s.bySession[sessionId]?.gitStatus : undefined))
  const folderRollup = useMemo(() => buildFolderRollup(gitStatusMap ?? {}), [gitStatusMap])
  rowsRef.current = rows

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
  const selectedAbsIndex = nodeAbsIndices[selectedNodeIndex]
  // Passing `tabIndex={-1}` on `<Virtuoso>` below removes that stop; `renderedRange` (fed by
  // `rangeChanged`) tracks which rows are CURRENTLY in the DOM at all, so the one real tree Tab
  // stop can be recomputed as "the selected row, if Virtuoso has it rendered; otherwise the first
  // rendered node row" -- without this, scrolling the selected row out of view (a mouse wheel, or
  // remounting at the top after a panel switch) left NO row anywhere with `tabIndex={0}`, so Tab
  // skipped the tree entirely.
  const [renderedRange, setRenderedRange] = useState<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 0 })
  const tabbableAbsIndex = useMemo(() => {
    if (
      selectedAbsIndex !== undefined &&
      selectedAbsIndex >= renderedRange.startIndex &&
      selectedAbsIndex <= renderedRange.endIndex
    ) {
      return selectedAbsIndex
    }
    for (let i = renderedRange.startIndex; i <= renderedRange.endIndex; i += 1) {
      if (rows[i]?.kind === 'node') return i
    }
    return undefined
  }, [selectedAbsIndex, renderedRange, rows])
  // Looks the pending path up directly rather than trusting `tabbableAbsIndex`/any index math,
  // since a row's actual presence in the DOM is exactly what failed last time.
  useEffect(() => {
    const pendingPath = pendingFocusPathRef.current
    if (!pendingPath) return
    if (!rowsRef.current.some((row) => row.kind === 'node' && row.node.path === pendingPath)) {
      pendingFocusPathRef.current = null
      return
    }
    const active = document.activeElement
    if (active && active !== document.body && !treeContainerRef.current?.contains(active)) {
      pendingFocusPathRef.current = null
      return
    }
    const target = treeContainerRef.current?.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(pendingPath)}"]`)
    if (!target) return
    pendingFocusPathRef.current = null
    target.focus({ preventScroll: true })
  }, [renderedRange])
  // Document-level, not container-scoped: the user may click outside this panel entirely (a chat
  // message, empty space).
  useEffect(() => {
    function clearPendingFocus(): void {
      pendingFocusPathRef.current = null
    }
    function clearPendingFocusIfOutside(event: FocusEvent): void {
      if (!treeContainerRef.current?.contains(event.target as Node | null)) clearPendingFocus()
    }
    document.addEventListener('pointerdown', clearPendingFocus, true)
    document.addEventListener('focusin', clearPendingFocusIfOutside, true)
    return () => {
      document.removeEventListener('pointerdown', clearPendingFocus, true)
      document.removeEventListener('focusin', clearPendingFocusIfOutside, true)
    }
  }, [])
  useEffect(() => {
    return () => {
      pendingFocusPathRef.current = null
      moveGenRef.current += 1
    }
  }, [sessionId])

  function activateRow(node: ExpandableNode): void {
    if (!sessionId) return
    if (node.kind === 'folder') {
      if (node.children === undefined) {
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
    // `{ opened: false }` is a normal result (contracts/ipc.md), never an IPC error --
    // `TreeNodeRow` shows the "VS Code not found" state inline, never a toast.
    return result.value.opened
  }

  async function handleReveal(path: string): Promise<void> {
    if (!sessionId) return
    const result = await window.refract.fileExplorer.reveal(sessionId, path)
    if (!result.ok) notify(result.error)
  }

  // Mirrors `useWorktreeActions.ts`'s own clipboard-first-then-IPC-fallback pattern, scoped to one
  // file's own absolute path instead of the whole worktree root.
  async function handleCopyPath(path: string, confirm = false): Promise<boolean> {
    if (!sessionId) return false
    if (worktreePath) {
      try {
        await navigator.clipboard.writeText(joinWorktreePath(worktreePath, path))
        if (confirm) toast.success('Path copied')
        return true
      } catch {
      }
    }
    const result = await window.refract.fileExplorer.copyPath(sessionId, path)
    if (result.ok && confirm) toast.success('Path copied')
    else if (!result.ok) notify(result.error)
    return result.ok
  }

  function moveToRow(row: NodeRow, absIndex: number): void {
    if (!sessionId) return
    setSelectedPath(sessionId, row.node.path)
    pendingFocusPathRef.current = null
    const gen = ++moveGenRef.current
    virtuosoRef.current?.scrollIntoView({
      index: absIndex,
      done: () => {
        if (gen !== moveGenRef.current) return
        const target = treeContainerRef.current?.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(row.node.path)}"]`)
        if (target) {
          pendingFocusPathRef.current = null
          target.focus()
        } else {
          pendingFocusPathRef.current = row.node.path
        }
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
      // Moves by one page of NODE rows (folders/files only, matching every other keyboard move
      // here, never counting a virtualised "N more" row), where a page is however many node-or-not
      // rows are CURRENTLY rendered (`renderedRange`, fed by Virtuoso's own `rangeChanged`) -- the
      // same notion of "a page" the user can actually see on screen, clamped to the first/last node
      // row rather than wrapping or doing nothing past either end.
      case 'PageDown': {
        event.preventDefault()
        const page = Math.max(1, renderedRange.endIndex - renderedRange.startIndex)
        const targetNodeIndex = Math.min(nodeAbsIndices.length - 1, row.nodeIndex + page)
        const targetAbs = nodeAbsIndices[targetNodeIndex]
        if (targetAbs !== undefined) moveToRow(rows[targetAbs] as NodeRow, targetAbs)
        break
      }
      case 'PageUp': {
        event.preventDefault()
        const page = Math.max(1, renderedRange.endIndex - renderedRange.startIndex)
        const targetNodeIndex = Math.max(0, row.nodeIndex - page)
        const targetAbs = nodeAbsIndices[targetNodeIndex]
        if (targetAbs !== undefined) moveToRow(rows[targetAbs] as NodeRow, targetAbs)
        break
      }
      case 'Enter': {
        event.preventDefault()
        selectAndActivate(node)
        break
      }
      default: {
        if (event.key === ' ') event.preventDefault()
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handleTypeahead(event.key, row)
        }
      }
    }
  }

  function handleRetry(): void {
    if (!sessionId) return
    containerRef.current?.focus()
    void loadDirectory(sessionId, '')
  }

  return (
    <div
      ref={containerRef}
      role="group"
      tabIndex={-1}
      aria-label="File explorer"
      className="@container flex h-full flex-col overflow-hidden p-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
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
        <InlineStatus tone="loading">Loading…</InlineStatus>
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
            <Button variant="ghost" onClick={handleRetry}>
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
          <div className="no-drag-region flex shrink-0 items-center justify-between gap-2 border-b border-divider px-1 pb-1">
            <label htmlFor="file-explorer-show-ignored" className="text-xs text-muted-foreground">
              Show ignored files
            </label>
            <Switch
              id="file-explorer-show-ignored"
              size="sm"
              checked={showIgnored}
              onCheckedChange={(checked) => sessionId && setShowIgnored(sessionId, checked)}
            />
          </div>
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="60%" minSize="20%">
              {rows.length === 0 ? (
                <InlineStatus density="compact">
                  Every entry here is ignored. Turn on "Show ignored files" above to see them.
                </InlineStatus>
              ) : (
                <div ref={treeContainerRef} role="tree" aria-label="Files" className="h-full">
                  <Virtuoso
                    ref={virtuosoRef}
                    style={{ height: '100%' }}
                    data={rows}
                    tabIndex={-1}
                    initialTopMostItemIndex={selectedAbsIndex ?? 0}
                    rangeChanged={setRenderedRange}
                    computeItemKey={(_index, row) => (row.kind === 'node' ? row.node.path : row.key)}
                    itemContent={(absIndex, row) =>
                      row.kind === 'more' ? (
                        <div
                          role="treeitem"
                          aria-disabled="true"
                          aria-level={row.depth + 1}
                          aria-setsize={row.setsize}
                          aria-posinset={row.posinset}
                          tabIndex={-1}
                          data-tree-more-key={row.key}
                          style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
                          className="px-1 py-1 text-xs text-muted-foreground"
                        >
                          {row.count} more…
                        </div>
                      ) : (
                        <TreeNodeRow
                          row={row}
                          absIndex={absIndex}
                          selected={row.nodeIndex === selectedNodeIndex}
                          tabbable={absIndex === tabbableAbsIndex}
                          rollup={row.node.kind === 'folder' ? folderRollup.get(row.node.path) : undefined}
                          onRowClick={selectAndActivate}
                          onRowFocus={(node) => sessionId && !rescueFocusRef.current && setSelectedPath(sessionId, node.path)}
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
            <ResizableHandle withHandle aria-label="Resize file tree and preview" />
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
