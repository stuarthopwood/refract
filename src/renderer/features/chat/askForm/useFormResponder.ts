import * as React from 'react'
import { answerFailureText } from '../askAnswerError'
import { createFormResponder, type FormResponder } from './formRequest'

export type FormSendPhase = 'idle' | 'sending' | 'sent'

interface UseFormResponder {
  responder: FormResponder
  phase: FormSendPhase
  /** Why OMP refused the last send, or null. */
  error: string | null
}

/** One once-only responder for a form request, with the send progress the card shows. */
export function useFormResponder(sessionId: string, requestId: string): UseFormResponder {
  const [phase, setPhase] = React.useState<FormSendPhase>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [responder] = React.useState(() =>
    createFormResponder(async (answer) => {
      setPhase('sending')
      setError(null)
      const result = await window.refract.chat.answer(sessionId, requestId, answer)
      if (!result.ok) {
        setError(answerFailureText(result.error))
        setPhase('idle')
        return false
      }
      setPhase('sent')
      return true
    })
  )
  return { responder, phase, error }
}
