import * as React from 'react'
import { create } from 'zustand'
import { usePendingRequestsStore } from '@/state/pending-requests-store'
import type { PendingRequest } from '../../../../shared/model'
import { type AskFieldValue, canSubmit } from './answerPlan'
import { afterAnswered, afterSendFailed, type AskFormSession, cancelSession, initialSession, nextAction, submitSession } from './askFormSession'
import type { AskFormField } from './parseAskHtml'

const NO_PENDING: PendingRequest[] = []

interface AskFormStoreState {
  byKey: Record<string, AskFormSession>
  update(key: string, init: AskFormSession, change: (session: AskFormSession) => AskFormSession): void
}

// Kept outside the card so the values and the answering progress survive the row unmounting
// (transcript windowing) while OMP's per-field frames are still arriving.
export const useAskFormStore = create<AskFormStoreState>((set) => ({
  byKey: {},
  update: (key, init, change) => set((state) => ({ byKey: { ...state.byKey, [key]: change(state.byKey[key] ?? init) } }))
}))

export const askFormKey = (sessionId: string, askItemId: string): string => `${sessionId}:${askItemId}`

/**
 * Whether the combined card owns this ask's frames, so no per-field card renders for them. The
 * session entry only exists once the card has acted, so a parsed form owns its frames until it falls back.
 */
export function useAskFormOwnsFrames(sessionId: string, askItemId: string | undefined, hasForm: boolean): boolean {
  const fellBack = useAskFormStore((state) => (askItemId ? state.byKey[askFormKey(sessionId, askItemId)]?.phase === 'fallback' : false))
  return hasForm && !fellBack
}

/**
 * Drives one parsed ask form: holds its values and, once submitted, answers each per-field frame
 * OMP sends, in order. A frame that does not fit the form switches the rest to per-field cards.
 */
export function useAskFormSession(sessionId: string, askItemId: string, fields: readonly AskFormField[]) {
  const key = askFormKey(sessionId, askItemId)
  const init = React.useMemo(() => initialSession(fields), [fields])
  const stored = useAskFormStore((state) => state.byKey[key])
  const session = stored ?? init
  const pending = usePendingRequestsStore((state) => state.bySession[sessionId] ?? NO_PENDING)
  const update = useAskFormStore((state) => state.update)

  React.useEffect(() => {
    // Read the store, not the render's snapshot: a StrictMode re-run must see the first run's `inflight`.
    const latest = useAskFormStore.getState().byKey[key] ?? init
    const action = nextAction(latest, fields, pending)
    if (action.type === 'none') return
    if (action.type === 'fallback') {
      update(key, init, (current) => ({ ...current, phase: 'fallback' }))
      return
    }
    const { requestId, answer } = action
    update(key, init, (current) => ({ ...current, inflight: requestId }))
    void window.refract.chat.answer(sessionId, requestId, answer).then((result) => {
      update(key, init, (current) => (result.ok ? afterAnswered(current, fields, requestId, answer) : afterSendFailed(current, result.error.message)))
    })
  }, [session, pending, key, init, fields, sessionId, update])

  const setValue = React.useCallback(
    (index: number, value: AskFieldValue) =>
      update(key, init, (current) => ({ ...current, values: current.values.map((existing, at) => (at === index ? value : existing)) })),
    [key, init, update]
  )
  const submit = React.useCallback(() => update(key, init, (current) => submitSession(current, fields)), [key, init, fields, update])
  // Cancels this form's frames pending now and any that arrive later, as the per-field Cancel does for one.
  const cancel = React.useCallback(() => update(key, init, cancelSession), [key, init, update])

  return { session, submittable: canSubmit(fields, session.values), setValue, submit, cancel }
}
