import type { ChatAnswer } from '../../../../shared/ipc'
import type { PendingRequest } from '../../../../shared/model'
import { type AskFieldValue, initialValue, planSteps, resolveStep } from './answerPlan'
import { matchFrame } from './matchFrame'
import type { AskFormField } from './parseAskHtml'

/**
 * `editing`: the user is filling the card. `answering`: Submit was pressed and each arriving frame
 * is answered in order. `cancelling`: every frame, pending now or arriving later, is cancelled.
 * `fallback`: a frame did not fit the form, so the remaining frames show as per-field cards.
 */
export type AskFormPhase = 'editing' | 'answering' | 'cancelling' | 'fallback' | 'done'

export interface AskFormSession {
  readonly values: readonly AskFieldValue[]
  readonly phase: AskFormPhase
  /** The field whose frames are being answered, and the step within that field's wire answers. */
  readonly cursor: number
  readonly stepIndex: number
  /** Frames this session already answered; the pending list can lag behind the answer. */
  readonly handled: readonly string[]
  readonly inflight: string | null
  readonly error: string | null
}

export type AskFormAction =
  | { readonly type: 'none' }
  | { readonly type: 'fallback' }
  | { readonly type: 'send'; readonly requestId: string; readonly answer: ChatAnswer }

export function initialSession(fields: readonly AskFormField[]): AskFormSession {
  return { values: fields.map(initialValue), phase: 'editing', cursor: 0, stepIndex: 0, handled: [], inflight: null, error: null }
}

type QuestionFrame = Extract<PendingRequest, { kind: 'question' }>

/** The oldest question frame this session has not answered yet. */
export function nextFrame(session: AskFormSession, pending: readonly PendingRequest[]): QuestionFrame | undefined {
  return pending.find((request): request is QuestionFrame => request.kind === 'question' && !session.handled.includes(request.requestId))
}

/** After "Other" OMP asks for the text in a frame whose title is its own prompt, not the field's question. */
const isFreeTextFrame = (frame: QuestionFrame): boolean => frame.inputKind === 'text' && !frame.secret

/** What to do with the next unanswered frame. Pure: the hook performs the answer and records the outcome. */
export function nextAction(session: AskFormSession, fields: readonly AskFormField[], pending: readonly PendingRequest[]): AskFormAction {
  if (session.inflight !== null || session.phase === 'fallback') return { type: 'none' }
  const frame = nextFrame(session, pending)
  if (!frame) return { type: 'none' }

  if (session.phase === 'cancelling') return { type: 'send', requestId: frame.requestId, answer: { cancelled: true } }
  // A frame arriving after the last field was answered is not part of the form.
  if (session.phase === 'done') return { type: 'fallback' }
  if (session.phase === 'editing') {
    const first = session.cursor === 0 && session.stepIndex === 0
    return first && matchFrame(fields, 0, frame) === null ? { type: 'fallback' } : { type: 'none' }
  }

  const field = fields[session.cursor]
  const value = session.values[session.cursor]
  const step = field && value ? planSteps(field, value)[session.stepIndex] : undefined
  if (!step) return { type: 'fallback' }
  if (step.kind === 'otherText') return isFreeTextFrame(frame) ? { type: 'send', requestId: frame.requestId, answer: { value: step.text } } : { type: 'fallback' }

  const match = matchFrame(fields, session.cursor, frame)
  const answer = match ? resolveStep(step, match) : null
  return answer ? { type: 'send', requestId: frame.requestId, answer } : { type: 'fallback' }
}

/** The session after `answer` to `requestId` was accepted by OMP. */
export function afterAnswered(session: AskFormSession, fields: readonly AskFormField[], requestId: string, answer: ChatAnswer): AskFormSession {
  const base = { ...session, handled: [...session.handled, requestId], inflight: null, error: null }
  if (session.phase !== 'answering' || 'cancelled' in answer) return base
  const field = fields[session.cursor]
  const value = session.values[session.cursor]
  const stepCount = field && value ? planSteps(field, value).length : 0
  if (session.stepIndex + 1 < stepCount) return { ...base, stepIndex: session.stepIndex + 1 }
  const cursor = session.cursor + 1
  return { ...base, cursor, stepIndex: 0, phase: cursor >= fields.length ? 'done' : 'answering' }
}
