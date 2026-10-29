import type { NavMessage } from './messageIndex'

export const OUTLINE_FIRST_LINE_MAX_CHARS = 100

export interface OutlineRow {
  /** The message id; unique per row. */
  key: string
  message: NavMessage
  /** 1 for an agent message nested under its turn's user message, otherwise 0. */
  depth: 0 | 1
  /** The id of the turn's user message when this row is a nested agent message. */
  parentKey: string | null
  /** Agent messages in this turn (user rows only). */
  childCount: number
  collapsed: boolean
  /** Position among all index messages, 1-based, for "Message N of M". */
  position: number
}

/** The Outline's rows in order: a user message is top level and its turn's agent messages follow
 * it, hidden while the turn is collapsed. An agent message ahead of any user message (a turn that
 * starts with the agent) has no parent and stays top level. */
export function buildOutlineRows(index: readonly NavMessage[], collapsedTurnKeys: ReadonlySet<string>): OutlineRow[] {
  const childCounts = new Map<string, number>()
  let parentKey: string | null = null
  for (const message of index) {
    if (message.kind === 'user') parentKey = message.id
    else if (parentKey !== null) childCounts.set(parentKey, (childCounts.get(parentKey) ?? 0) + 1)
  }
  const rows: OutlineRow[] = []
  parentKey = null
  index.forEach((message, at) => {
    if (message.kind === 'user') {
      parentKey = message.id
      rows.push({
        key: message.id,
        message,
        depth: 0,
        parentKey: null,
        childCount: childCounts.get(message.id) ?? 0,
        collapsed: collapsedTurnKeys.has(message.id),
        position: at + 1
      })
      return
    }
    if (parentKey !== null && collapsedTurnKeys.has(parentKey)) return
    rows.push({ key: message.id, message, depth: parentKey === null ? 0 : 1, parentKey, childCount: 0, collapsed: false, position: at + 1 })
  })
  return rows
}

/** The key of the row to mark as the current position. A message hidden inside a collapsed turn
 * is represented by its turn's row. */
export function resolveCurrentRowKey(rows: readonly OutlineRow[], index: readonly NavMessage[], currentMessageId: string | null): string | null {
  if (currentMessageId === null) return null
  if (rows.some((row) => row.key === currentMessageId)) return currentMessageId
  const at = index.findIndex((message) => message.id === currentMessageId)
  for (let i = at - 1; i >= 0; i -= 1) {
    const candidate = index[i]
    if (candidate?.kind === 'user') return rows.some((row) => row.key === candidate.id) ? candidate.id : null
  }
  return null
}

/** Ids of every turn that can collapse (a user message with at least one agent message). */
export function collapsibleTurnKeys(index: readonly NavMessage[]): string[] {
  const keys: string[] = []
  let parent: string | null = null
  let hasChild = false
  const flush = () => {
    if (parent !== null && hasChild) keys.push(parent)
  }
  for (const message of index) {
    if (message.kind === 'user') {
      flush()
      parent = message.id
      hasChild = false
    } else if (parent !== null) hasChild = true
  }
  flush()
  return keys
}

/** Drops collapsed ids that no longer name a turn, so the saved set never grows stale. */
export function pruneCollapsed(collapsed: ReadonlySet<string>, index: readonly NavMessage[]): ReadonlySet<string> {
  if (collapsed.size === 0) return collapsed
  const live = new Set(index.map((message) => message.id))
  const next = new Set([...collapsed].filter((id) => live.has(id)))
  return next.size === collapsed.size ? collapsed : next
}

export function outlineItemLabel(row: OutlineRow): string {
  const { message } = row
  if (message.firstLine !== '') {
    const chars = Array.from(message.firstLine)
    return chars.length > OUTLINE_FIRST_LINE_MAX_CHARS ? `${chars.slice(0, OUTLINE_FIRST_LINE_MAX_CHARS - 1).join('')}…` : message.firstLine
  }
  return message.kind === 'agent' ? 'Writing…' : '(empty message)'
}

export function formatOutlineTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Index of the row to land on for a roving-tabindex key; clamps to the list. */
export function stepRowIndex(current: number, key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End', count: number): number {
  if (count === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const next = key === 'ArrowDown' ? current + 1 : current - 1
  return Math.max(0, Math.min(count - 1, next))
}
