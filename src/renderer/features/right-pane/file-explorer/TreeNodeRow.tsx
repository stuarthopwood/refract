// One row of the File explorer treeview (spec 015 T012/T025, spec 035 T012/T013): extracted from
// `FileExplorerPanel.tsx` unchanged apart from the Git decoration (#768) and the inline row
// actions (#756), so the panel stays under its file-size baseline.
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  FileIcon,
  FileWarningIcon,
  FolderIcon,
  FolderOpenIcon
} from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { GitStatusMark } from '../../../../shared/model'
import type { ExpandableNode } from '../../../state/file-explorer-store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STATUS_MARKS } from './git-decoration'
import { PATH_ACTIONS, type PathActionHandlers } from './path-actions'
import { TreeRowActions } from './TreeRowActions'

export interface NodeRow {
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

export function TreeNodeRow({
  row,
  absIndex,
  selected,
  tabbable,
  rollup,
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
  /** PR #671 gate round 4 fix (High, A11y4): the ONE roving-tabindex stop, computed by the
   * parent from `rangeChanged` (`tabbableAbsIndex`) rather than always following `selected` --
   * when the selected row has scrolled out of Virtuoso's own rendered window, `selected` would
   * otherwise point at a row that does not exist in the DOM at all, leaving NO tree row
   * reachable by Tab. */
  tabbable: boolean
  /** Folder rows only: the most significant status among this folder's descendants (#768). */
  rollup?: GitStatusMark
  onRowClick: (node: ExpandableNode) => void
  onRowFocus: (node: ExpandableNode) => void
  onRowKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: NodeRow, absIndex: number) => void
  onOpenInVSCode: (path: string) => Promise<boolean>
  onReveal: (path: string) => Promise<void>
  onCopyPath: (path: string, confirm?: boolean) => Promise<boolean>
}) {
  const node = row.node
  const isFolder = node.kind === 'folder'
  const expanded = node.expanded === true
  const mark = node.gitStatus ? STATUS_MARKS[node.gitStatus] : null
  // Git decoration: a row's own mark wins; a folder with none of its own takes its rollup.
  const decoration = node.gitStatus ?? (isFolder ? rollup : undefined)
  const decorationClass = decoration ? STATUS_MARKS[decoration].className : null
  const containsChanges = isFolder && !node.gitStatus && !!rollup
  const iconClass = `size-4 shrink-0 ${decorationClass ?? 'text-muted-foreground'}`
  // T025: a file/folder row's own 3 actions (Open in VS Code, Reveal in File Explorer, Copy
  // path) -- never offered for a `cannot-access` row, which has nothing safe to open/reveal/
  // copy (main could not even resolve it).
  const canAct = node.kind !== 'cannot-access'
  const rowRef = useRef<HTMLDivElement>(null)
  // PR #671 gate round 4 fix (Medium, A11y4): the row's own accessible name was being built from
  // EVERY child in document order, including the kebab button's own `aria-label` ("More actions
  // for X") and the transient "VS Code not found" status text -- a screen reader read the whole
  // row as "staged.ts Added More actions for staged.ts". `aria-labelledby` scopes the row's name
  // to exactly the name span and (when present) the status-mark span, leaving the kebab and any
  // transient status text out of it (they still read their own separate accessible names/text
  // when focused or announced directly).
  //
  // Gate round 5 fix (Code5 Low, re-flagged A11y5 Medium): ids built from the node's own PATH
  // (as this comment used to justify, "stable, unique per row") break `aria-labelledby` the
  // instant a path contains a space -- `aria-labelledby` is a whitespace-SEPARATED id list, so
  // `fe-row-my file.ts-name` reads as two separate (nonexistent) ids, not one. `useId()` is
  // perfectly referenceable here despite being generated at render time: it is read in THIS SAME
  // render's JSX below, never serialised or passed across a render boundary, so there is no
  // "needs a plain string before render" constraint it fails to meet -- the original worry this
  // comment raised does not actually apply to this call site.
  const rowIdBase = useId()
  const nameId = `${rowIdBase}-name`
  const markId = `${rowIdBase}-mark`
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

  // The one handler set behind the inline buttons and both menus (`path-actions.tsx`).
  const handlers: PathActionHandlers = {
    openInVSCode: () => void runOpenInVSCode(),
    reveal: () => void onReveal(node.path),
    copyPath: (confirm) => onCopyPath(node.path, confirm)
  }
  // Action menus are text only (components.md, Menus).
  const menuActions = PATH_ACTIONS.map(({ key, label }) => ({ key, label, onSelect: () => void (key === 'copyPath' ? handlers.copyPath(true) : handlers[key]()) }))

  const rowContent = (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-selected={selected}
      aria-expanded={isFolder ? expanded : undefined}
      aria-labelledby={mark ? `${nameId} ${markId}` : nameId}
      // PR #671 gate round 4 fix (Medium, A11y4): the kebab's own keyboard-only reveal (Shift+F10 or the ContextMenu key) is now at least advertised on the row itself.
      aria-keyshortcuts={canAct ? 'Shift+F10' : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-tree-row-path={node.path}
      style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
      className="group no-drag-region relative flex w-full cursor-default items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent aria-selected:text-accent-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]"
      onClick={() => onRowClick(node)}
      // Only the row itself selects on focus: clicking an inline button or the kebab focuses that child, which must not select the row.
      onFocus={(event) => event.target === event.currentTarget && onRowFocus(node)}
      onKeyDown={(event) => onRowKeyDown(event, row, absIndex)}
    >
      {selected && <ActiveIndicatorBar />}
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {isFolder && (expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />)}
      </span>
      {isFolder ? (
        expanded ? (
          <FolderOpenIcon aria-hidden className={iconClass} />
        ) : (
          <FolderIcon aria-hidden className={iconClass} />
        )
      ) : node.kind === 'cannot-access' ? (
        <FileWarningIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon aria-hidden className={iconClass} />
      )}
      <span id={nameId} className={`min-w-0 flex-1 truncate ${decorationClass ?? 'text-chat-foreground'}`} title={node.name}>
        {node.name}
        {node.kind === 'cannot-access' && <span className="sr-only"> (cannot access)</span>}
        {containsChanges && <span className="sr-only"> (contains changes)</span>}
      </span>
      {mark && (
        <span id={markId} title={mark.label} className="flex shrink-0 items-center">
          <mark.Icon aria-hidden className={`size-4 ${mark.className}`} />
          <span className="sr-only">{mark.label}</span>
        </span>
      )}
      {containsChanges && (
        // WCAG 1.4.1: a non-colour cue beside the tint, for collapsed and expanded folders alike. The
        // accessible text is the name span's sr-only "contains changes".
        <span aria-hidden className={'size-1.5 shrink-0 rounded-full bg-current ' + decorationClass} />
      )}
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      {canAct && (
        <TreeRowActions selected={selected} handlers={handlers} />
      )}
      {canAct && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild aria-describedby={undefined}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  aria-label={`More actions for ${node.name}`}
                  // Visible whenever this row is SELECTED (not hover/focus-within only, which read as
                  // hover-only on touch), a 24px target (PR #671 gate round 4, A11y4).
                  className={`shrink-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 ${selected ? 'opacity-100' : 'opacity-0'}`}
                  // The whole row carries `onClick`/`onRowClick` above; without this the trigger click would also select/activate it.
                  onClick={(event) => event.stopPropagation()}
                >
                  <EllipsisVerticalIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{`More actions for ${node.name}`}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" onCloseAutoFocus={handleMenuCloseAutoFocus}>
            {menuActions.map((action) => (
              <DropdownMenuItem key={action.key} onSelect={action.onSelect}>
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
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
