import type { AskFieldValue } from './answerPlan'
import type { AskFormChoiceField, AskFormField, AskFormSelectField } from './parseAskHtml'

/** What one control submits: text, a number for number/range inputs, or the checked values of a group. */
export type AskFormDataValue = string | number | string[]

/** The `form` answer OMP takes, keyed by control name; a control with nothing chosen is absent. */
export type AskFormData = Record<string, AskFormDataValue>

type ChoiceLike = AskFormChoiceField | AskFormSelectField

// OMP rejects a form answer that breaks its own submit rules, so the rules below mirror its `fieldError` and
// `choiceValue` rather than HTML's: a drift would let Submit send a value OMP then refuses.

/** Radio and checkbox groups of two or more options offer a free-text "Other" unless an option already is one. */
export function offersOther(field: AskFormField): boolean {
  if (field.kind !== 'radio' && field.kind !== 'checkbox') return false
  return field.options.length > 1 && !field.options.some((option) => /^\s*other\b/i.test(option.label))
}

/** Checkbox groups and multi-selects with several options answer with an array; a lone checkbox answers with its value. */
function isArrayChoice(field: ChoiceLike): boolean {
  return (field.kind === 'checkbox' || (field.kind === 'select' && field.multiple)) && field.options.length > 1
}

function choiceValue(field: ChoiceLike, value: AskFieldValue | undefined): AskFormDataValue | undefined {
  const picked = value?.kind === 'choice' ? value : null
  const typed = picked?.otherSelected && offersOther(field) ? picked.otherText.trim() : ''
  const checked = field.options.flatMap((option) => (!option.disabled && picked?.selected.includes(option.value) ? [option.value] : []))
  if (isArrayChoice(field)) return typed ? [...checked, typed] : checked
  return typed || checked[0]
}

function fieldValue(field: AskFormField, value: AskFieldValue | undefined): AskFormDataValue | undefined {
  if ('options' in field) return choiceValue(field, value)
  const text = value?.kind === 'text' ? value.text : ''
  if ((field.kind === 'number' || field.kind === 'range') && text.trim() !== '') {
    const number = Number(text)
    if (Number.isFinite(number)) return number
  }
  return text
}

function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'v').test(text)
  } catch {
    // An invalid pattern is ignored, as OMP and HTML do.
    return true
  }
}

function isUrl(text: string): boolean {
  try {
    new URL(text)
    return true
  } catch {
    return false
  }
}

function fieldError(field: AskFormField, value: AskFormDataValue | undefined): string | null {
  if ('options' in field) {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0)
    if (!field.required || !empty) return null
    return isArrayChoice(field) ? 'Select at least one' : 'Required'
  }
  const text = value === undefined ? '' : String(value)
  if (text.trim() === '') return field.required ? 'Required' : null
  if (field.kind === 'number' || field.kind === 'range') {
    const number = Number(text)
    if (!Number.isFinite(number)) return 'Enter a number'
    if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`
    if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`
  }
  if (field.minLength !== undefined && text.length < field.minLength) return `Needs at least ${field.minLength} characters`
  if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`
  if (field.kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) return 'Enter an email address'
  if (field.kind === 'url' && !isUrl(text)) return 'Enter a full URL'
  if (field.kind !== 'textarea' && field.pattern && !matchesPattern(field.pattern, text)) {
    return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`
  }
  return null
}

/** One message per field, in field order, or `null` where the field is acceptable; Submit waits until all are `null`. */
export function validateAskForm(fields: readonly AskFormField[], values: readonly AskFieldValue[]): (string | null)[] {
  return fields.map((field, index) => fieldError(field, fieldValue(field, values[index])))
}

/**
 * The `data` object of OMP's `form` answer. Radios, single checkboxes and single selects give one string
 * (absent when nothing is chosen); checkbox groups and multi-selects give an array; number and range give
 * a number once filled; every other text control gives its text. Controls without a `name` are left out.
 * A later control sharing a name replaces an earlier one that had an answer.
 */
export function toFormData(fields: readonly AskFormField[], values: readonly AskFieldValue[]): AskFormData {
  // A null prototype keeps a control named `__proto__` an ordinary key.
  const data: AskFormData = Object.create(null) as AskFormData
  fields.forEach((field, index) => {
    if (field.unnamed) return
    const value = fieldValue(field, values[index])
    if (value !== undefined) data[field.name] = value
  })
  return data
}
