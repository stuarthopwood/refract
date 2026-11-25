import type { ChatAnswer, IpcError, Result } from '../../../../shared/ipc'
import { initialValue, type AskFieldValue } from './answerPlan'
import type { AskFormField, AskFormInputField } from './parseAskHtml'
import { toFormData, validateAskForm } from './validateAskForm'

export const FORM_CANCEL: ChatAnswer = { cancelled: true }
export const FORM_TIMED_OUT: ChatAnswer = { cancelled: true, timedOut: true }

/** HTML submits a range's midpoint, snapped to its step from min, when it was never moved, so an untouched slider must hold that number too. */
function rangeMidpoint(field: AskFormInputField): string {
  const min = field.min ?? 0
  const max = field.max ?? 100
  if (max <= min) return String(min)
  const step = field.step !== undefined && field.step > 0 ? field.step : 1
  let value = min + Math.round((max - min) / 2 / step) * step
  if (value > max) value -= step
  return String(Number(value.toFixed(10)))
}

export function startingValues(fields: readonly AskFormField[]): AskFieldValue[] {
  return fields.map((field) => {
    const value = initialValue(field)
    return field.kind === 'range' && value.kind === 'text' && value.text === '' ? { kind: 'text', text: rangeMidpoint(field) } : value
  })
}

export interface FormSubmission {
  readonly errors: readonly (string | null)[]
  /** The `data` answer, or `null` while any field is invalid. */
  readonly answer: ChatAnswer | null
}

export function formSubmission(fields: readonly AskFormField[], values: readonly AskFieldValue[]): FormSubmission {
  const errors = validateAskForm(fields, values)
  return { errors, answer: errors.every((error) => error === null) ? { data: toFormData(fields, values) } : null }
}

/** A message shows once its field was touched or Submit was tried, so an untouched form is not a wall of errors. */
export function visibleErrors(errors: readonly (string | null)[], touched: ReadonlySet<number>, attempted: boolean): (string | null)[] {
  return errors.map((error, index) => (attempted || touched.has(index) ? error : null))
}

/** The first field Submit is blocked on, or -1 when all are acceptable. */
export function firstInvalidField(errors: readonly (string | null)[]): number {
  return errors.findIndex((error) => error !== null)
}

/** A touched set that now holds `index`; the same set when it already does, so state does not re-render for nothing. */
export function withTouched(touched: ReadonlySet<number>, index: number): ReadonlySet<number> {
  return touched.has(index) ? touched : new Set(touched).add(index)
}

/** `locked` is a timed-out cancel OMP refused: the deadline has passed, so only a retry of that cancel is offered. */
export type FormSendPhase = 'idle' | 'sending' | 'sent' | 'locked'
export type AnswerKind = 'submitted' | 'cancelled' | 'timedOut'

export function answerKind(answer: ChatAnswer): AnswerKind {
  if (!('cancelled' in answer)) return 'submitted'
  return answer.timedOut ? 'timedOut' : 'cancelled'
}

const SENDING_NOTE: Record<AnswerKind, string> = { submitted: 'Submitting your answers', cancelled: 'Cancelling', timedOut: 'Cancelling' }
const SENT_NOTE: Record<AnswerKind, string> = { submitted: 'Answers submitted', cancelled: 'Cancelled', timedOut: 'Timed out, cancelled' }

/** The status line names what was sent, so a Cancel or a deadline never reads as a submit. */
export function formStatusNote(phase: FormSendPhase, kind: AnswerKind | null): string | undefined {
  if (kind === null) return undefined
  if (phase === 'sending') return SENDING_NOTE[kind]
  return phase === 'sent' ? SENT_NOTE[kind] : undefined
}

/** Submit spins only for a submit, and Cancel only for a cancel or the deadline's, so neither shows work it is not doing. */
export function footerBusy(phase: FormSendPhase, kind: AnswerKind | null): { sending: boolean; cancelling: boolean } {
  const inFlight = phase === 'sending'
  return { sending: inFlight && kind === 'submitted', cancelling: inFlight && kind !== null && kind !== 'submitted' }
}

/** Retry is offered for a locked timed-out cancel and stays, busy, while its resend is in flight. */
export function retryState(phase: FormSendPhase, kind: AnswerKind | null): { visible: boolean; busy: boolean } {
  return { visible: phase === 'locked' || (phase === 'sending' && kind === 'timedOut'), busy: phase === 'sending' }
}

/** A refused send that lands after the deadline cannot be fixed by editing: the form is timed out instead of re-opened. */
export function refusedPastDeadline(phase: FormSendPhase, error: string | null, deadlineAt: number | undefined, now: number): boolean {
  return phase === 'idle' && error !== null && deadlineAt !== undefined && now >= deadlineAt
}

/** The error of a refused send describes that attempt, so an edit drops it; a locked or sent form keeps its own. */
export function shouldClearErrorOnEdit(phase: FormSendPhase, error: string | null): boolean {
  return phase === 'idle' && error !== null
}

export interface SendOutcome {
  readonly accepted: boolean
  readonly phase: FormSendPhase
  readonly error: string | null
}

export const SEND_FAILED_TEXT = "Your answer couldn't be sent. Try again."

/** A refused or failed send re-opens the form, except a timed-out cancel, which locks it: editing past the deadline cannot help. */
export async function sendFormAnswer(answer: ChatAnswer, call: () => Promise<Result<void>>, failureText: (error: IpcError) => string): Promise<SendOutcome> {
  const refused = (error: string): SendOutcome => ({ accepted: false, phase: answerKind(answer) === 'timedOut' ? 'locked' : 'idle', error })
  try {
    const result = await call()
    return result.ok ? { accepted: true, phase: 'sent', error: null } : refused(failureText(result.error))
  } catch {
    return refused(SEND_FAILED_TEXT)
  }
}

/** A static line, as for the ask card: the form is cancelled on the user's behalf once the time passes. */
export function formDeadlineText(deadlineAt: number): string {
  const time = new Date(deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `If there's no answer by ${time}, the form is cancelled.`
}

// setTimeout fires immediately for a delay beyond 2^31 - 1 ms, so a far deadline is reached in slices.
const MAX_TIMER_MS = 2_147_483_647

/** Runs `fire` when `deadlineAt` (epoch ms) passes, at once if it already has. Returns the cancel function. */
export function scheduleDeadline(deadlineAt: number | undefined, now: number, fire: () => void): () => void {
  if (deadlineAt === undefined) return () => undefined
  let timer: ReturnType<typeof setTimeout>
  const arm = (delay: number): void => {
    timer = setTimeout(() => {
      const remaining = deadlineAt - Date.now()
      if (remaining > 0) arm(remaining)
      else fire()
    }, Math.min(Math.max(delay, 0), MAX_TIMER_MS))
  }
  arm(deadlineAt - now)
  return () => clearTimeout(timer)
}

export interface FormResponder {
  /** Resolves true once OMP took the answer; false when it was refused, or another send was in flight or already done. */
  respond(answer: ChatAnswer): Promise<boolean>
}

/**
 * OMP takes exactly one response per form, so a second Submit, a Cancel racing the deadline, or a retry
 * while one send is in flight must not reach it. A refused send re-opens the responder so the user can retry.
 */
export function createFormResponder(send: (answer: ChatAnswer) => Promise<boolean>): FormResponder {
  let busy = false
  let done = false
  return {
    async respond(answer) {
      if (busy || done) return false
      busy = true
      try {
        done = await send(answer)
      } finally {
        busy = false
      }
      return done
    }
  }
}
