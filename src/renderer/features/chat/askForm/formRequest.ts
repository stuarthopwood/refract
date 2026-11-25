import type { ChatAnswer } from '../../../../shared/ipc'
import { initialValue, type AskFieldValue } from './answerPlan'
import type { AskFormField, AskFormInputField } from './parseAskHtml'
import { toFormData, validateAskForm } from './validateAskForm'

export const FORM_CANCEL: ChatAnswer = { cancelled: true }
export const FORM_TIMED_OUT: ChatAnswer = { cancelled: true, timedOut: true }
export const FORM_UNSHOWN_NOTICE = 'This form could not be shown, so it was cancelled.'

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
