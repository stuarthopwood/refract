// The parts a Session row adds when its Project group is a tree (#1862). Kept out of `SessionRow.tsx`
// so that file stays one row; each piece is a plain function or component so it renders to markup on its own.
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import { cn } from '@/lib/utils'
import { childCountLabel, fromLabelText, needsYouLabel, rollUp, rollUpLabel, type FromLabel, type SessionTreeNode } from './sessionTree'

/** What `SessionTree` hands a row: its place in the tree and the state of its own disclosure. */
export interface SessionRowTreeProps {
  node: SessionTreeNode
  /** The group's top-level nodes: the keyboard handler flattens them to find the next visible row. */
  roots: readonly SessionTreeNode[]
  /** Null for a root Session or a parent unknown to the store. */
  from: FromLabel | null
  /** Whether this parent shows its children; meaningless for a leaf. */
  open: boolean
  /** A collapsed parent takes the open-Session state while a hidden descendant is the selected Session. */
  selectedBelow: boolean
}

/** One level is 12 px, and the indent stops at level 4 (36 px) so a bad file never overflows the row. */
export const TREE_INDENT_STEP_PX = 12

export function treeIndentPx(indentLevel: number): number {
  return (indentLevel - 1) * TREE_INDENT_STEP_PX
}

export function treeOpenButtonId(sessionId: string): string {
  return `${sessionId}-open`
}

export function treeGroupId(sessionId: string): string {
  return `${sessionId}-children`
}

export function hasTreeChildren(tree: SessionRowTreeProps): boolean {
  return tree.node.children.length > 0
}

/** The `<li role="treeitem">` attributes. `aria-labelledby` names the item by its open button, so the nested group is not read into the name. */
export function treeItemAttributes(tree: SessionRowTreeProps, sessionId: string) {
  const { node, open } = tree
  return {
    role: 'treeitem' as const,
    'aria-level': node.level,
    'aria-setsize': node.setSize,
    'aria-posinset': node.posInSet,
    'aria-labelledby': treeOpenButtonId(sessionId),
    'aria-expanded': hasTreeChildren(tree) ? open : undefined,
    'data-session-id': sessionId,
    style: { '--tree-indent': `${treeIndentPx(node.indentLevel)}px` } as CSSProperties
  }
}

/** A collapsed parent puts what waits inside it in its name; an open parent's child says so itself. */
export function treeNamePart(tree: SessionRowTreeProps): string | null {
  return hasTreeChildren(tree) && !tree.open ? needsYouLabel(rollUp(tree.node).needsYou) : null
}

/** The count and the "from" line, which the sr-only description and the details card carry instead of the name. */
export function treeDescription(tree: SessionRowTreeProps): string | null {
  const parts = [hasTreeChildren(tree) ? childCountLabel(tree.node.children.length) : null, tree.from ? fromLabelText(tree.from) : null]
  const text = parts.filter((part): part is string => Boolean(part)).join('. ')
  return text || null
}

export function TreeToggle({
  name,
  sessionId,
  open,
  onToggle,
  onKeyDown
}: {
  name: string
  sessionId: string
  open: boolean
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <IconButton
      size="icon-xs"
      label={`${open ? 'Collapse' : 'Expand'} ${name}`}
      // Set only while the group is rendered: a collapsed parent has no element to control.
      aria-controls={open ? treeGroupId(sessionId) : undefined}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      // Sits in the row's existing 24 px gutter, at the row's own indent, so the status icon never moves.
      className={cn(
        'absolute left-(--tree-indent) top-0.5 z-10 text-muted-foreground hover:bg-sidebar-border hover:text-foreground dark:hover:bg-sidebar-border',
        COMPOSER_BUTTON_FOCUS_CLASS
      )}
    >
      <ChevronRightIcon aria-hidden className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
    </IconButton>
  )
}

/**
 * A parent's second line: the count first, in a segment that never shrinks, then whatever the row
 * shows today in the slot that truncates. A collapsed parent with something waiting shows the
 * roll-up alone, so the attention text is not pushed off the line by a long branch name.
 */
export function TreeLineTwo({ tree, metaFg, slot }: { tree: SessionRowTreeProps; metaFg: string; slot: ReactNode }) {
  const collapsed = !tree.open
  const roll = rollUp(tree.node)
  const rollShowing = collapsed && roll.needsYou > 0
  return (
    <span className="flex min-w-0 items-baseline gap-1 pl-6 text-xs">
      <span data-testid="session-tree-count" className={cn('shrink-0 whitespace-nowrap', metaFg)}>
        {rollUpLabel(roll, collapsed)}
      </span>
      {!rollShowing && slot ? (
        <>
          <span aria-hidden className={cn('shrink-0', metaFg)}>
            ·
          </span>
          {slot}
        </>
      ) : null}
    </span>
  )
}

/** The third line of a child row. "from " and the state suffix never shrink; the parent's name carries the ellipsis. */
export function TreeFromLine({ from, metaFg }: { from: FromLabel; metaFg: string }) {
  return (
    <span data-testid="session-from-line" className={cn('flex min-w-0 pl-6 text-xs', metaFg)}>
      <span className="shrink-0 whitespace-pre">from </span>
      <span className="truncate">{from.name}</span>
      {from.suffix && <span className="shrink-0 whitespace-pre"> {from.suffix}</span>}
    </span>
  )
}
