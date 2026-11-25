import type { ChatAnswer } from '../../../../shared/ipc'
import { initialValue, type AskFieldValue } from './answerPlan'
import type { AskFormChoiceField, AskFormField, AskFormTextField } from './parseAskHtml'
import { toFormData, validateAskForm } from './validateAskForm'

export const FORM_CANCEL: ChatAnswer = { cancelled: true }
export const FORM_TIMED_OUT: ChatAnswer = { cancelled: true, timedOut: true }
export const FORM_UNSHOWN_NOTICE = 'This form could not be shown, so it was cancelled.'

/** The field kinds OMP 18.x's per-field frames can carry; the select and typed inputs exist only in a v19 whole form. */
export type AskFormFrameField = AskFormChoiceField | AskFormTextField

export function isFrameField(field: AskFormField): field is AskFormFrameField {
  return field.kind === 'radio' || field.kind === 'checkbox' || field.kind === 'text' || field.kind === 'textarea'
}

/** HTML submits a range's midpoint when it was never moved, so an untouched slider must hold that number too. */
function rangeMidpoint(field: Extract<AskFormField, { kind: 'range' }>): string {
  const min = field.min ?? 0
  const max = field.max ?? 100
  return String(min + (max - min) / 2)
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

/** A static line, as for the ask card: the form is cancelled on the user's behalf once the time passes. */
export function formDeadlineText(deadlineAt: number): string {
  const time = new Date(deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `If there's no answer by ${time}, the form is cancelled.`
}

// setTimeout fires immediately for a delay beyond 2^31 - 1 ms, which would time a far deadline out at once.
const MAX_TIMER_MS = 2_147_483_647

/** Runs `fire` when `deadlineAt` (epoch ms) passes, at once if it already has. Returns the cancel function. */
export function scheduleDeadline(deadlineAt: number | undefined, now: number, fire: () => void): () => void {
  if (deadlineAt === undefined) return () => undefined
  const timer = setTimeout(fire, Math.min(Math.max(deadlineAt - now, 0), MAX_TIMER_MS))
  return () => clearTimeout(timer)
}

/**
 * OMP takes exactly one response per form, so a second Submit, a Cancel racing the deadline, or a retry
 * while one send is in flight must not reach it. A refused send re-opens the responder so the user can retry.
 */
export function createFormResponder(send: (answer: ChatAnswer) => Promise<boolean>) {
  let busy = false
  let done = false
  return {
    async respond(answer: ChatAnswer): Promise<boolean> {
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
