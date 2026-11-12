import type { ChatAnswer } from '../../../../shared/ipc'
import type { FrameMatch } from './matchFrame'
import type { AskFormField } from './parseAskHtml'

/** What the card holds for one field: choice groups track option values plus "Other"; text fields track the string. */
export type AskFieldValue =
  | { readonly kind: 'choice'; readonly selected: readonly string[]; readonly otherSelected: boolean; readonly otherText: string }
  | { readonly kind: 'text'; readonly text: string }

/** One wire answer OMP expects, in order, for a field. */
export type AnswerStep =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'other' }
  | { readonly kind: 'otherText'; readonly text: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'text'; readonly text: string }

export function initialValue(field: AskFormField): AskFieldValue {
  if ('options' in field) return { kind: 'choice', selected: field.defaultValue, otherSelected: false, otherText: '' }
  return { kind: 'text', text: field.defaultValue }
}

/** An Other choice with an empty text box is unanswered. */
function hasOther(value: Extract<AskFieldValue, { kind: 'choice' }>): boolean {
  return value.otherSelected && value.otherText.trim().length > 0
}

export function isAnswered(value: AskFieldValue): boolean {
  if (value.kind === 'text') return value.text.trim().length > 0
  return value.selected.length > 0 || hasOther(value)
}

/**
 * The first field Submit is waiting on, or -1. A field the HTML marks `required` must be answered,
 * and so must every radio group: OMP has no "none" row to send for an unanswered one.
 */
export function firstMissingField(fields: readonly AskFormField[], values: readonly AskFieldValue[]): number {
  return fields.findIndex((field, index) => {
    const value = values[index]
    const mustAnswer = field.required || field.kind === 'radio'
    return mustAnswer && (value === undefined || !isAnswered(value))
  })
}

export function canSubmit(fields: readonly AskFormField[], values: readonly AskFieldValue[]): boolean {
  return firstMissingField(fields, values) === -1
}

/** What a blocked Submit tells the user, naming the field it is waiting on, or `null` when nothing is missing. */
export function missingFieldMessage(fields: readonly AskFormField[], values: readonly AskFieldValue[]): string | null {
  const missing = fields[firstMissingField(fields, values)]
  return missing ? `${missing.question.replace(/\s+/g, ' ').trim()} is required` : null
}

/**
 * The ordered wire answers for a field. Checkbox groups toggle each chosen row and always end with
 * `Done selecting`. A radio group with nothing chosen plans no steps; Submit is blocked until
 * every radio group is answered, so that case never reaches the wire.
 */
export function planSteps(field: AskFormField, value: AskFieldValue): AnswerStep[] {
  if (!('options' in field) || value.kind !== 'choice') {
    return [{ kind: 'text', text: value.kind === 'text' ? value.text.trim() : '' }]
  }
  const other: AnswerStep[] = hasOther(value) ? [{ kind: 'other' }, { kind: 'otherText', text: value.otherText.trim() }] : []
  if (field.kind === 'radio') {
    const index = field.options.findIndex((option) => value.selected.includes(option.value))
    if (index !== -1) return [{ kind: 'option', index }]
    return other
  }
  const toggled: AnswerStep[] = []
  field.options.forEach((option, index) => {
    if (value.selected.includes(option.value)) toggled.push({ kind: 'option', index })
  })
  return [...toggled, ...other, { kind: 'done' }]
}

/** The answer for `step` against the frame that arrived, or `null` when the frame lacks the row. */
export function resolveStep(step: AnswerStep, match: FrameMatch | null): ChatAnswer | null {
  switch (step.kind) {
    case 'text':
    case 'otherText':
      return { value: step.text }
    case 'option': {
      const row = match?.optionRows[step.index]
      return row ? { value: row } : null
    }
    case 'other':
      return match?.otherRow ? { value: match.otherRow } : null
    case 'done':
      return match?.doneRow ? { value: match.doneRow } : null
  }
}
