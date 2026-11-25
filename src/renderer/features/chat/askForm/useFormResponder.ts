import * as React from 'react'
import { answerFailureText } from '../askAnswerError'
import { answerKind, createFormResponder, sendFormAnswer, type AnswerKind, type FormResponder, type FormSendPhase } from './formRequest'

interface UseFormResponder {
  responder: FormResponder
  phase: FormSendPhase
  /** What the last send was, for the status line; null before any send. */
  kind: AnswerKind | null
  /** Why OMP refused the last send, or null. */
  error: string | null
  /** Drops the shown refusal once the user starts editing again. */
  clearError: () => void
}

/** One once-only responder for a form request, with the send progress the card shows. */
export function useFormResponder(sessionId: string, requestId: string): UseFormResponder {
  const [phase, setPhase] = React.useState<FormSendPhase>('idle')
  const [kind, setKind] = React.useState<AnswerKind | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [responder] = React.useState(() =>
    createFormResponder(async (answer) => {
      setPhase('sending')
      setKind(answerKind(answer))
      // The last refusal stays until this send settles, so a Retry that sent it stays mounted instead of dropping focus.
      const outcome = await sendFormAnswer(answer, () => window.refract.chat.answer(sessionId, requestId, answer), answerFailureText)
      setPhase(outcome.phase)
      setError(outcome.error)
      return outcome.accepted
    })
  )
  const clearError = React.useCallback(() => setError(null), [])
  return { responder, phase, kind, error, clearError }
}
