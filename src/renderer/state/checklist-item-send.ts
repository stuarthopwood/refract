import type { Checklist } from '../../shared/checklist'
import type { ChecklistItemAction } from '../../shared/ipc-checklist'
import { refusalLine } from '../features/right-pane/checklist/item-controls'
import { draftKey, useChecklistDraftsStore } from './checklist-drafts'
import { selectSessionChecklist, useChecklistStore } from './checklist-store'

export interface ItemSend {
  sessionId: string
  itemId: string
  action: ChecklistItemAction
  /** The textarea's text; "Do this item" has none. */
  text?: string
  agentRunning: boolean
}

// `by: 'developer'` keeps the store from announcing the developer's own change as an agent's.
const adopt = (sessionId: string, checklist: Checklist | null): void => {
  if (checklist !== null) useChecklistStore.getState().applyUpdate({ sessionId, checklist, by: 'developer' })
}

/** Sends one item action and records the outcome; true only when it went. A draft is cleared only by a send that came from the form. */
export async function sendItemAction({ sessionId, itemId, action, text, agentRunning }: ItemSend): Promise<boolean> {
  const checklist = selectSessionChecklist(useChecklistStore.getState(), sessionId).checklist
  if (checklist === null) return false
  const drafts = useChecklistDraftsStore.getState()
  const key = draftKey({ sessionId, checklistId: checklist.id, itemId })
  if (drafts.inFlight[key]) return false
  drafts.beginSend(key)
  const fromForm = action !== 'complete'
  const finish = (note: Parameters<typeof drafts.succeed>[1]): boolean => {
    const store = useChecklistDraftsStore.getState()
    if (fromForm) store.succeed(key, note)
    else store.settle(key, note)
    return true
  }
  const refuse = (message: string): boolean => {
    useChecklistDraftsStore.getState().refuse(key, message)
    return false
  }

  // With no agent a value is only saved: `itemMessage` would refuse it, and the value is the developer's own.
  if (action === 'value' && !agentRunning) {
    const result = await window.refract.checklist.mutate(sessionId, checklist.id, checklist.rev, null, { op: 'setValue', id: itemId, value: text ?? '' })
    if (!result.ok) return refuse(`Not saved. ${result.error.message}`)
    if ('error' in result.value) {
      adopt(sessionId, result.value.checklist)
      return refuse(`Not saved. ${result.value.error.message}`)
    }
    adopt(sessionId, result.value)
    return finish({ kind: 'delivery', delivery: 'saved' })
  }

  const result = await window.refract.checklist.itemMessage(sessionId, checklist.id, itemId, checklist.rev, action, text)
  // The Session refused the send after Rust stored a value, so a value stays saved only on this branch.
  if (!result.ok) return refuse(refusalLine(action, result.error.message))
  if ('error' in result.value) {
    adopt(sessionId, result.value.checklist)
    return refuse(refusalLine(action, result.value.error.message, false))
  }
  adopt(sessionId, result.value.checklist)
  return finish({ kind: 'delivery', delivery: result.value.delivery })
}
