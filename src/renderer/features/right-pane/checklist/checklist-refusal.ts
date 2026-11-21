import type { ItemRefusal } from '@/state/checklist-store'
import { CHECKLIST_STATUS_GLYPH } from './checklist-status'

/** `item_changed` is a benign race, not a failure; anything else is a refusal worth an error. */
export const refusalTone = (refusal: ItemRefusal): 'notice' | 'error' => (refusal.code === 'item_changed' ? 'notice' : 'error')

/**
 * The line shown under a refused item. `item_changed` follows what the agent holds the item at now:
 * already complete means the developer's intent is met, anything else can be ticked again.
 * Any other refusal shows Rust's own message.
 */
export function refusalMessage(refusal: ItemRefusal): string {
  if (refusal.code !== 'item_changed') return refusal.message
  if (refusal.status === undefined) return 'The agent changed this item. Check it, then try again if you still want to.'
  if (refusal.status === 'complete') return 'The agent already marked this item complete.'
  return `The agent changed this item to ${CHECKLIST_STATUS_GLYPH[refusal.status].word.toLowerCase()}. Tick again if you still want it.`
}
