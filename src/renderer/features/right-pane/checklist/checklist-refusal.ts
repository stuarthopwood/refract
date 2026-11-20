import type { ItemRefusal } from '@/state/checklist-store'
import { CHECKLIST_STATUS_GLYPH } from './checklist-status'

/** The line shown under a refused item: `item_changed` names what the agent changed it to, any other refusal shows Rust's own message. */
export function refusalMessage(refusal: ItemRefusal): string {
  if (refusal.code !== 'item_changed') return refusal.message
  const now = refusal.status === undefined ? '' : ` to ${CHECKLIST_STATUS_GLYPH[refusal.status].word.toLowerCase()}`
  return `The agent changed this item${now}. Tick again if you still want it.`
}
