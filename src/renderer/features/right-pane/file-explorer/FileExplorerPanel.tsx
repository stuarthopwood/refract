// File explorer panel (spec 015): the fifth right-pane tenant. Slice 1 (T006-T010) ships the
// shell plus a real, lazily-loaded listing of the Session's own worktree -- no keyboard/ARIA tree
// pattern yet (Slice 2, FR-022), no preview, no git status marks, no Open in VS Code. A plain,
// click-to-expand nested list, same incremental-shippability spec 013/014's own Slice 1s used.
import { useEffect } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useFileExplorerStore } from '@/state'
import type { FileTreeNode } from '../../../../shared/model'

type ExpandableNode = FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean }

interface FileExplorerPanelProps {
  /** The Session this tree follows -- no independent binding of its own (FR-004), the same
   * pattern spec 013's Subagents panel and spec 014's Side chat already use: it always reflects
   * whichever Session the chat pane currently shows. */
  sessionId: string | null
}

export function FileExplorerPanel({ sessionId }: FileExplorerPanelProps) {
  const root = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.root ?? null) : null))
  const loaded = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.loaded ?? false) : false))
  const loadDirectory = useFileExplorerStore((s) => s.loadDirectory)
  const toggleExpanded = useFileExplorerStore((s) => s.toggleExpanded)

  // FR-004/FR-005: the root listing, once per Session per app run (mirrors side-chat's own
  // `loadHistory`-on-first-open effect, spec 014).
  useEffect(() => {
    if (!sessionId || loaded) return
    void loadDirectory(sessionId, '')
  }, [sessionId, loaded, loadDirectory])

  if (!sessionId) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No Session open</EmptyTitle>
          <EmptyDescription>Open a Session to browse its files.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  function handleToggle(node: ExpandableNode): void {
    if (!sessionId) return
    if (node.children === undefined) {
      // First expand: fetch, which also sets `expanded: true` on success (store's own
      // `withChildrenAt`).
      void loadDirectory(sessionId, node.path)
      return
    }
    // Already fetched (collapsing or re-expanding): flip the local flag only, never re-fetch.
    toggleExpanded(sessionId, node.path)
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-2">
      {!loaded ? (
        <p className="p-2 text-sm text-muted-foreground">Loading…</p>
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
        <ul className="flex flex-col gap-0.5">
          {root.children.map((node) => (
            <TreeRow key={node.path} node={node} depth={0} onToggle={handleToggle} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  onToggle
}: {
  node: ExpandableNode
  depth: number
  onToggle: (node: ExpandableNode) => void
}) {
  const isFolder = node.kind === 'folder'
  const expanded = node.expanded === true
  return (
    <li>
      <button
        type="button"
        className="no-drag-region flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => isFolder && onToggle(node)}
        disabled={!isFolder}
      >
        {isFolder ? (
          expanded ? <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" /> : <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <span className="inline-block size-3.5 shrink-0" aria-hidden />
        )}
        {isFolder ? (
          expanded ? <FolderOpenIcon aria-hidden className="size-4 shrink-0" /> : <FolderIcon aria-hidden className="size-4 shrink-0" />
        ) : (
          <FileIcon aria-hidden className="size-4 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isFolder && expanded && node.children && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  )
}
