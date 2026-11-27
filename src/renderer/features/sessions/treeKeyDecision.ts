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

export interface ConversationKeyContext {
  /** A Session with listed child Sessions keeps plain Right and Left for them; the Conversation list then takes Alt. */
  hasChildSessions: boolean
  listOpen: boolean
  /** Entries currently rendered under the Session. */
  entryCount: number
}

export interface SessionConversationKeyDecision {
  prevent: boolean
  /** The wanted open state of the Conversation list, or null when it stays as it is. */
  setOpen: boolean | null
  focusFirstEntry: boolean
}

const NO_SESSION_KEY: SessionConversationKeyDecision = { prevent: false, setOpen: null, focusFirstEntry: false }

/** Keys on a Session's open button that reach its nested Conversation list (FR-196). */
export function decideSessionConversationKey(event: TreeKeyEvent, context: ConversationKeyContext): SessionConversationKeyDecision {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return NO_SESSION_KEY
  const { listOpen, entryCount, hasChildSessions } = context
  const intoList = listOpen && entryCount > 0
  if (event.key === 'ArrowDown' && !event.altKey) return intoList ? { prevent: true, setOpen: null, focusFirstEntry: true } : NO_SESSION_KEY
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return NO_SESSION_KEY
  if (hasChildSessions && !event.altKey) return NO_SESSION_KEY
  if (event.key === 'ArrowRight') {
    if (!listOpen) return { prevent: true, setOpen: true, focusFirstEntry: false }
    return { prevent: true, setOpen: null, focusFirstEntry: intoList }
  }
  return listOpen ? { prevent: true, setOpen: false, focusFirstEntry: false } : NO_SESSION_KEY
}

export type ConversationEntryTarget = { kind: 'entry'; index: number } | { kind: 'session' } | { kind: 'next-session' }

/** Where focus goes from entry `index` of `count`, or null when the key is not an entry key. */
export function decideConversationEntryKey(event: TreeKeyEvent, index: number, count: number): ConversationEntryTarget | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null
  switch (event.key) {
    case 'ArrowDown':
      return index < count - 1 ? { kind: 'entry', index: index + 1 } : { kind: 'next-session' }
    case 'ArrowUp':
      return index > 0 ? { kind: 'entry', index: index - 1 } : { kind: 'session' }
    case 'Home':
      return { kind: 'entry', index: 0 }
    case 'End':
      return { kind: 'entry', index: count - 1 }
    case 'ArrowLeft':
      return { kind: 'session' }
    default:
      return null
  }
}
