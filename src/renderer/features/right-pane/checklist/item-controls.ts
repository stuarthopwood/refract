import { CHECKLIST_CAPS, type ChecklistItem } from '../../../../shared/checklist'
import type { ChecklistItemAction, ChecklistItemDelivery } from '../../../../shared/ipc-checklist'
import { needsValueToTick } from './checklist-tick'

/** What the form sends: a question for the agent, or a value for the item. */
export type ItemFormMode = Exclude<ChecklistItemAction, 'complete'>

export type ItemPresentation = 'awaiting_input' | 'in_progress' | 'plain'

/** Where an item stands for the developer; in progress wins because the agent already has it. */
export const derivePresentation = (item: ChecklistItem): ItemPresentation => {
  if (item.status === 'in_progress') return 'in_progress'
  return needsValueToTick(item) ? 'awaiting_input' : 'plain'
}

/** Whether "Do this item" is shown at all; an item the agent is on stays shown, disabled. */
export const showsDoItem = (item: ChecklistItem): boolean => item.agentCompletable && item.owner !== 'human' && item.status !== 'complete'

/** Whether "Do this item" can be sent: unlike a tick, only a value the developer set counts. */
export const canDoItem = (item: ChecklistItem): boolean => {
  if (!showsDoItem(item) || item.status === 'in_progress') return false
  return !item.requiresValue || (item.value !== undefined && item.value !== '' && item.valueBy === 'developer')
}

const encoder = new TextEncoder()

/** The size the Rust caps count. */
export const byteLength = (text: string): number => encoder.encode(text).length

/** Where the turn went, in words; a turn sent now needs no line. */
export const deliveryLine = (delivery: ChecklistItemDelivery | 'not_running'): string | null => {
  if (delivery === 'queued') return 'Queued after the current turn'
  if (delivery === 'held') return 'Held until you resume'
  if (delivery === 'not_running') return 'Agent not running'
  return null
}

/** Why Send cannot go yet, or null; asking needs a live agent, a value does not. */
export const sendBlock = (mode: ItemFormMode, text: string, agentRunning: boolean): string | null => {
  if (text.trim() === '') return 'Type something to send.'
  const cap = mode === 'value' ? CHECKLIST_CAPS.maxValueBytes : CHECKLIST_CAPS.maxItemMessageBytes
  if (byteLength(text) > cap) return 'Too long to send.'
  if (mode === 'ask' && !agentRunning) return 'The agent is not running, so it cannot be asked. You can still save a value on the item.'
  return null
}

/** The alert after a send that did not go; it says what the developer kept so they know what is safe. */
export const refusalLine = (action: ChecklistItemAction, reason: string): string => {
  const kept = action === 'value' ? 'Your value is saved on the item.' : action === 'ask' ? 'Your question is still in the box.' : 'The item is unchanged.'
  return reason === '' ? `Not sent. ${kept}` : `Not sent. ${kept} ${reason}`
}

/** Ctrl+Enter, or Cmd+Enter on a Mac, sends from the textarea. */
export const isSendChord = (event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean => event.key === 'Enter' && (event.ctrlKey || event.metaKey)

/** The label on Send: with no agent a value is saved, not sent. */
export const sendLabel = (mode: ItemFormMode, agentRunning: boolean): string => (mode === 'value' && !agentRunning ? 'Save value' : 'Send')
