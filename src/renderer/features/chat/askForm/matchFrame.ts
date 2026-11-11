import type { PendingRequest } from '../../../../shared/model'
import type { AskFormField } from './parseAskHtml'

/** The rows OMP appends to every choice frame; they are not part of the HTML form. */
const OTHER_ROW = /^Other \(type your own\)$/i
const DONE_ROW = /^(?:\[OK\]|[✔✓☑])?\s*Done selecting$/i
const SELECTED_PREFIX = /^\(\d+ selected\) /

export interface FrameMatch {
  readonly fieldIndex: number
  readonly field: AskFormField
  /** For each of the field's options, the exact wire row that carries it, or `null` when the frame omits it. */
  readonly optionRows: readonly (string | null)[]
  readonly otherRow: string | null
  readonly doneRow: string | null
}

export const isOtherRow = (row: string): boolean => OTHER_ROW.test(row.trim())
export const isDoneRow = (row: string): boolean => DONE_ROW.test(row.trim())

/** Lower-cased, whitespace-collapsed, and without the `(N selected) ` re-prompt prefix or a trailing colon. */
function normaliseLabel(text: string): string {
  return text.replace(SELECTED_PREFIX, '').replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase()
}

/**
 * Pairs the next incoming per-field frame with `fields[cursor]`. `null` is a mismatch (no field
 * left, a different type, a different label, or an option the form does not have), and the caller
 * falls back to today's per-field cards for the remaining fields.
 */
export function matchFrame(fields: readonly AskFormField[], cursor: number, request: PendingRequest): FrameMatch | null {
  const field = fields[cursor]
  if (!field || request.kind !== 'question' || request.secret) return null
  if (normaliseLabel(request.title) !== normaliseLabel(field.question)) return null

  if (!('options' in field)) {
    return request.inputKind === 'text' ? { fieldIndex: cursor, field, optionRows: [], otherRow: null, doneRow: null } : null
  }
  if (request.inputKind !== 'choice') return null

  let otherRow: string | null = null
  let doneRow: string | null = null
  const optionRows: (string | null)[] = field.options.map(() => null)
  for (const row of request.options) {
    if (isOtherRow(row)) otherRow = row
    else if (isDoneRow(row)) doneRow = row
    else {
      const at = field.options.findIndex((option, index) => optionRows[index] === null && (option.label === row || option.value === row))
      if (at === -1) return null
      optionRows[at] = row
    }
  }
  // Only checkbox groups carry a Done row, which is how a radio group is told apart from one.
  if ((field.kind === 'checkbox') !== (doneRow !== null)) return null
  return { fieldIndex: cursor, field, optionRows, otherRow, doneRow }
}

/** Whether a frame is one of this form's own fields, at any position; Cancel touches only those. */
export function frameBelongsToForm(fields: readonly AskFormField[], request: PendingRequest): boolean {
  return fields.some((_, index) => matchFrame(fields, index, request) !== null)
}
