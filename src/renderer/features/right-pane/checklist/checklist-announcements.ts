import type { Checklist } from '../../../../shared/checklist'
import { CHECKLIST_STATUS_GLYPH } from './checklist-status'

const MAX_LISTED_CHANGES = 3

/** Spoken when the agent creates a checklist in the front Session. */
export const openedAnnouncement = (checklist: Checklist): string => {
  const count = checklist.items.length
  return `Checklist opened: ${checklist.title}, ${count} ${count === 1 ? 'item' : 'items'}`
}

/** Spoken when the agent creates a checklist that retires the active one. */
export const REPLACED_ANNOUNCEMENT = 'Checklist replaced'

/** What changed between two revisions of one checklist, or null when no item was added, removed or re-statused. Long lists are summarised so a single announcement stays short. */
export function describeAgentChange(previous: Checklist, next: Checklist): string | null {
  const before = new Map(previous.items.map((item) => [item.id, item]))
  const kept = new Set(next.items.map((item) => item.id))
  const changes: string[] = []
  for (const item of next.items) {
    const old = before.get(item.id)
    if (old === undefined) changes.push(`Item added: ${item.text}`)
    else if (old.status !== item.status) changes.push(`${item.text} is now ${CHECKLIST_STATUS_GLYPH[item.status].word.toLowerCase()}`)
  }
  for (const item of previous.items) if (!kept.has(item.id)) changes.push(`Item removed: ${item.text}`)
  if (changes.length === 0) return null
  return changes.length > MAX_LISTED_CHANGES ? `${changes.length} items changed` : changes.join('. ')
}
