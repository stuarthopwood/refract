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

const MAX_PATTERN_LENGTH = 200
const MAX_INPUT_LENGTH = 1_000
const MAX_COUNT = 1_000
const COUNTED_QUANTIFIER = /\{(\d+)(?:(,)(\d*))?\}/y
const METACHARS = '\\^$.*+?()[]{}|'
const ESCAPE = /[\\^$.*+?()[\]{}|/\-dwsDWS]/

// Length of the flat class starting at `start`, or 0 when it holds anything but literals, ranges and simple escapes.
function classLength(pattern: string, start: number): number {
  let index = start + 1
  if (pattern[index] === '^') index++
  const first = index
  while (index < pattern.length) {
    const char = pattern[index] ?? ''
    if (char === ']') return index > first ? index - start + 1 : 0
    if (char === '\\') {
      if (!ESCAPE.test(pattern[index + 1] ?? '')) return 0
      index += 2
    } else if (char === '[' || char === '-' || (char === '&' && pattern[index + 1] === '&')) {
      return 0
    } else {
      const end = pattern[index + 2] ?? ''
      index += pattern[index + 1] === '-' && end !== '' && !'[]\\-'.includes(end) ? 3 : 1
    }
  }
  return 0
}

// Length of the single-character atom at `index`, or 0 when there is none.
function atomLength(pattern: string, index: number): number {
  const char = pattern[index] ?? ''
  if (char === '\\') return ESCAPE.test(pattern[index + 1] ?? '') ? 2 : 0
  if (char === '[') return classLength(pattern, index)
  return char === '.' || !METACHARS.includes(char) ? 1 : 0
}

// The quantifier starting at `index`, or null; `variable` is false for a fixed `{n}`, which cannot backtrack.
function quantifierAt(pattern: string, index: number): { length: number; variable: boolean } | null {
  const char = pattern[index]
  if (char === '*' || char === '+' || char === '?') return { length: 1, variable: true }
  if (char !== '{') return null
  COUNTED_QUANTIFIER.lastIndex = index
  const match = COUNTED_QUANTIFIER.exec(pattern)
  if (!match) return null
  const [whole = '', low = '', comma, high = ''] = match
  const min = Number(low)
  if (min > MAX_COUNT) return null
  if (comma === undefined) return min >= 1 ? { length: whole.length, variable: false } : null
  if (high === '') return { length: whole.length, variable: true }
  const max = Number(high)
  return max > min && max <= MAX_COUNT ? { length: whole.length, variable: true } : null
}

// The pattern is the agent's and runs on the UI thread, so it runs only when built from a small allow-list: every atom
// matches exactly one character, so the single variable quantifier is the only choice point. OMP still checks on submit.
function isCheapPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false
  let variableQuantifiers = 0
  let index = 0
  while (index < pattern.length) {
    if (pattern[index] === '^' || pattern[index] === '$') {
      index++
      continue
    }
    const atom = atomLength(pattern, index)
    if (atom === 0) return false
    index += atom
    const quantifier = quantifierAt(pattern, index)
    if (!quantifier) continue
    if (quantifier.variable && ++variableQuantifiers > 1) return false
    index += quantifier.length
    if (pattern[index] === '?') index++
  }
  return true
}

function matchesPattern(pattern: string, text: string): boolean {
  if (text.length > MAX_INPUT_LENGTH || !isCheapPattern(pattern)) return true
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
