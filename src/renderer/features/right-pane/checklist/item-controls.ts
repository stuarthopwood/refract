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

export const DO_ITEM_LABEL = 'Do this item'
export const IN_PROGRESS_LABEL = 'Agent is doing this item'

/** What "Do this item" says on its face; an item the agent is on stays shown, with its state in words. */
export const doItemLabel = (item: ChecklistItem): string => (item.status === 'in_progress' ? IN_PROGRESS_LABEL : DO_ITEM_LABEL)

/** Why "Do this item" cannot go, shown as text beside it; null when it can, or when the label already says the agent has it. */
export const doItemHint = (item: ChecklistItem, agentRunning: boolean): string | null => {
  if (item.status === 'in_progress') return null
  if (!agentRunning) return 'The agent is not running, so it cannot do this item.'
  return canDoItem(item) ? null : 'Add a value first, then the agent can do this item.'
}

const encoder = new TextEncoder()

/** The size the Rust caps count. */
export const byteLength = (text: string): number => encoder.encode(text).length

/** The byte cap the form enforces for its mode. */
export const capFor = (mode: ItemFormMode): number => (mode === 'value' ? CHECKLIST_CAPS.maxValueBytes : CHECKLIST_CAPS.maxItemMessageBytes)

/** Where the turn went, in words; a turn sent now needs no line. */
export const deliveryLine = (delivery: ChecklistItemDelivery | 'saved' | 'not_running'): string | null => {
  if (delivery === 'queued') return 'Queued after the current turn'
  if (delivery === 'held') return 'Held until you resume'
  if (delivery === 'saved') return 'Value saved on the item'
  if (delivery === 'not_running') return 'Agent not running'
  return null
}

/** Shown beside the form, not in a tooltip, so a developer without an agent sees why asking is off. */
export const ASK_UNAVAILABLE_REASON = 'The agent is not running, so it cannot be asked. You can still save a value on the item.'

/** Why Send cannot go yet, or null; asking needs a live agent, a value does not. */
export const sendBlock = (mode: ItemFormMode, text: string, agentRunning: boolean): string | null => {
  if (text.trim() === '') return 'Type something to send.'
  if (byteLength(text) > capFor(mode)) return 'Too long to send.'
  if (mode === 'ask' && !agentRunning) return ASK_UNAVAILABLE_REASON
  return null
}

/** The alert after a send that did not go; it says what the developer kept so they know what is safe. */
export const refusalLine = (action: ChecklistItemAction, reason: string, valueStored = true): string => {
  const kept =
    action === 'value'
      ? valueStored
        ? 'Your value is saved on the item.'
        : 'Your value is still in the box.'
      : action === 'ask'
        ? 'Your question is still in the box.'
        : 'The item is unchanged.'
  return reason === '' ? `Not sent. ${kept}` : `Not sent. ${kept} ${reason}`
}

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  preventDefault?: () => void
  stopPropagation?: () => void
}

/** Ctrl+Enter, or Cmd+Enter on a Mac, sends from the textarea. */
export const isSendChord = (event: KeyLike): boolean => event.key === 'Enter' && (event.ctrlKey || event.metaKey)

/** Ctrl+Enter sends and Escape closes; both are consumed so the pane around the form does not also act on them. */
export const handleFormKey = (event: KeyLike, actions: { send: () => void; close: () => void }): void => {
  if (isSendChord(event)) {
    event.preventDefault?.()
    actions.send()
  } else if (event.key === 'Escape') {
    event.preventDefault?.()
    event.stopPropagation?.()
    actions.close()
  }
}

/** The label on Send: with no agent a value is saved, not sent. */
export const sendLabel = (mode: ItemFormMode, agentRunning: boolean): string => (mode === 'value' && !agentRunning ? 'Save value' : 'Send')

export interface FocusTarget {
  focus: () => void
}

// The form unmounts on close, so focus must move to the disclosure first or it lands on `<body>`.
/** Closes the form, keeping its draft, and returns focus to the item's disclosure button. */
export const dismissForm = (close: () => void, target: FocusTarget | null): void => {
  close()
  target?.focus()
}

/** Runs the send; focus returns to the disclosure only when it went, since a refused send keeps the form open. */
export const submitAndRefocus = async (send: () => Promise<boolean>, target: FocusTarget | null): Promise<void> => {
  if (await send()) target?.focus()
}
