import type { TranscriptItem } from '../../../shared/model'
import type { UserItem } from './UserMessageRow'

export interface Turn {
  userItem: UserItem | null
  items: TranscriptItem[]
}

// Any items ahead of the first `user` item (should not normally occur) form a leading turn with no
// total-time line (`userItem: null`).
export function splitIntoTurns(items: readonly TranscriptItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn = { userItem: null, items: [] }
  for (const item of items) {
    if (item.kind === 'user') {
      if (current.items.length > 0) turns.push(current)
      current = { userItem: item, items: [item] }
    } else {
      current.items.push(item)
    }
  }
  turns.push(current)
  return turns
}

/**
 * Keeps the previous Turn (and so its `items` array, the key of the per-turn grouping cache) for every turn whose items are
 * unchanged by element identity. A streaming delta then replaces only the growing turn, not every turn above it.
 */
export function reuseUnchangedTurns(previous: readonly Turn[], next: Turn[]): Turn[] {
  return next.map((turn, index) => {
    const before = previous[index]
    return before && before.items.length === turn.items.length && before.items.every((item, i) => item === turn.items[i]) ? before : turn
  })
}
