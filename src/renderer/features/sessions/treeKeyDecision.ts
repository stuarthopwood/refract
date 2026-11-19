// What a tree-group key press does to the DOM, decided without touching it so the hook that applies it stays thin (#1862, FR-009).
import { treeKeyMove, type SessionTreeNode, type TreeKeyEvent } from './sessionTree'

export interface TreeKeyDecision {
  /** The key was a tree key with a target: the caller must `preventDefault` and report it handled. */
  prevent: boolean
  /** The parent whose collapse state must flip, or null when none does (also when it is already in the wanted state). */
  toggleId: string | null
  /** The row whose open button takes focus, or null. */
  focusId: string | null
}

const IGNORED: TreeKeyDecision = { prevent: false, toggleId: null, focusId: null }

/** `visibleRows` is `flattenVisible`'s output, so a collapsed parent's children are never a focus target. */
export function decideTreeKey(
  visibleRows: readonly SessionTreeNode[],
  focusedId: string,
  event: TreeKeyEvent,
  isParentOpen: (id: string) => boolean
): TreeKeyDecision {
  const move = treeKeyMove(visibleRows, focusedId, event, isParentOpen)
  if (!move) return IGNORED
  if (move.kind === 'focus') return { prevent: true, toggleId: null, focusId: move.id }
  return { prevent: true, toggleId: isParentOpen(move.id) !== move.open ? move.id : null, focusId: null }
}
