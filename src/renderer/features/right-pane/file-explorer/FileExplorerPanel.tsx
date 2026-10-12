// File explorer panel (spec 015): the fifth right-pane tenant. Slice 1 (T006-T010) ships the
// shell plus a real, lazily-loaded listing of the Session's own worktree -- no keyboard/ARIA tree
// pattern yet (Slice 2, FR-022), no preview, no git status marks, no Open in VS Code. A plain,
// click-to-expand nested list, same incremental-shippability spec 013/014's own Slice 1s used.
import { useEffect, useRef } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FileWarningIcon,
  FolderIcon,
  FolderOpenIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useFileExplorerStore } from '@/state'
import type { ExpandableNode } from '../../../state/file-explorer-store'

/** A focused element the user can no longer usefully interact with: gone from the document,
 * parked on `<body>` (the browser's own fallback once a focused node is removed), or a
 * now-disabled control still sitting inside `root`. Copied verbatim from `ChatPane.tsx`'s own
 * `isFocusStranded` (PR #671 gate fix, accessibility-auditor/code-reviewer MEDIUM, round 2: the
 * previous round's own comment CLAIMED this pattern but did not actually use it -- a plain
 * `onFocus`/`onBlur` pair instead, which never sees a blur for a node removed out from under it,
 * and which unconditionally reclaimed focus on every Session change even when focus had
 * deliberately moved elsewhere, e.g. the sidebar row just clicked). One shared definition would
 * belong in `lib/focus.ts` if a second caller ever needs it; not extracted there yet since this
 * is still the only one outside `ChatPane.tsx` itself. */
function isFocusStranded(active: Element | null, root: HTMLElement | null): boolean {
  return (
    !active ||
    active === document.body ||
    !active.isConnected ||
    (active instanceof HTMLElement && active.matches(':disabled') && !!root?.contains(active))
  )
}

interface FileExplorerPanelProps {
  /** The Session this tree follows -- no independent binding of its own (FR-004), the same
   * pattern spec 013's Subagents panel and spec 014's Side chat already use: it always reflects
   * whichever Session the chat pane currently shows. */
  sessionId: string | null
}

export function FileExplorerPanel({ sessionId }: FileExplorerPanelProps) {
  const root = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.root ?? null) : null))
  const status = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.status ?? 'loading') : 'loading'))
  const error = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.error ?? null) : null))
  const loadDirectory = useFileExplorerStore((s) => s.loadDirectory)
  const toggleExpanded = useFileExplorerStore((s) => s.toggleExpanded)

  const containerRef = useRef<HTMLDivElement>(null)
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
  // fix, accessibility-auditor/code-reviewer MEDIUM, round 2).
  useEffect(() => {
    if (!hadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (isFocusStranded(active, containerRef.current)) containerRef.current?.focus()
    })
  }, [sessionId, status])

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
      className="flex h-full flex-col overflow-y-auto p-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {status === 'loading' ? (
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
  const rowClassName = 'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm'
  return (
    <li>
      {isFolder ? (
        <button
          type="button"
          className={`no-drag-region ${rowClassName} hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring`}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          onClick={() => onToggle(node)}
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          {expanded ? (
            <FolderOpenIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <FolderIcon aria-hidden className="size-4 shrink-0" />
          )}
          <span className="truncate" title={node.name}>
            {node.name}
          </span>
        </button>
      ) : (
        // PR #671 gate fix (accessibility-auditor MEDIUM): a file (or `cannot-access`) row is NOT
        // a `<button disabled>` -- a screen reader in browse mode read every one of those as
        // "button, unavailable/dimmed", announcing a broken control rather than a plain row with
        // nothing to activate. A non-interactive `<span>`, no `disabled` attribute and no hover
        // background, matches what it actually is. A later slice turns this into an unselected
        // `treeitem`, replacing this element rather than adding roles on top of it.
        <span className={rowClassName} style={{ paddingLeft: `${depth * 16 + 4}px` }}>
          <span className="inline-block size-3.5 shrink-0" aria-hidden />
          {node.kind === 'cannot-access' ? (
            <FileWarningIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <FileIcon aria-hidden className="size-4 shrink-0" />
          )}
          <span className="truncate" title={node.name}>
            {node.name}
            {node.kind === 'cannot-access' && <span className="sr-only"> (cannot access)</span>}
          </span>
        </span>
      )}
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
