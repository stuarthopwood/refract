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
  tabbable: boolean
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
  const decoration = node.gitStatus ?? (isFolder ? rollup : undefined)
  const decorationClass = decoration ? STATUS_MARKS[decoration].className : null
  const containsChanges = isFolder && !node.gitStatus && !!rollup
  const iconClass = `size-4 shrink-0 ${decorationClass ?? 'text-muted-foreground'}`
  const canAct = node.kind !== 'cannot-access'
  const rowRef = useRef<HTMLDivElement>(null)
  const rowIdBase = useId()
  const nameId = `${rowIdBase}-name`
  const markId = `${rowIdBase}-mark`
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

  function handleMenuCloseAutoFocus(event: Event): void {
    event.preventDefault()
    rowRef.current?.focus()
  }

  const handlers: PathActionHandlers = {
    openInVSCode: () => void runOpenInVSCode(),
    reveal: () => void onReveal(node.path),
    copyPath: (confirm) => onCopyPath(node.path, confirm)
  }
  const menuActions = PATH_ACTIONS.map(({ key, label, icon }) => ({ key, label, icon, onSelect: () => void (key === 'copyPath' ? handlers.copyPath(true) : handlers[key]()) }))

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
      aria-keyshortcuts={canAct ? 'Shift+F10' : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-tree-row-path={node.path}
      style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
      className="group no-drag-region relative flex w-full cursor-default items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-row-hover-bg focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent aria-selected:text-accent-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]"
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
                  className={`shrink-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 ${selected ? 'opacity-100' : 'opacity-0'}`}
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
              <DropdownMenuItem key={action.key} icon={action.icon} onSelect={action.onSelect}>
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
          <ContextMenuItem key={action.key} icon={action.icon} onSelect={action.onSelect}>
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
