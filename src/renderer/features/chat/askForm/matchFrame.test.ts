import { describe, expect, test } from 'vitest'
import type { PendingRequest } from '../../../../shared/model'
import { frameBelongsToForm, isDoneRow, isOtherRow, matchFrame } from './matchFrame'
import type { AskFormField } from './parseAskHtml'

const FIELDS: AskFormField[] = [
  { kind: 'radio', name: 'db', question: 'Which database?', required: false, options: [{ value: 'Postgres', label: 'Postgres' }, { value: 'SQLite', label: 'SQLite' }], defaultValue: [] },
  { kind: 'checkbox', name: 'features', question: 'Which features?', required: false, options: [{ value: 'Auth', label: 'Auth' }, { value: 'Billing', label: 'Billing' }], defaultValue: [] },
  { kind: 'text', name: 'why', question: 'Why?', required: false, defaultValue: '' },
]

type Question = Extract<PendingRequest, { kind: 'question' }>

function choice(title: string, options: string[]): Question {
  return { kind: 'question', requestId: 'r1', title, options, inputKind: 'choice' }
}

const text = (title: string, extra: Partial<Question> = {}): Question => ({ kind: 'question', requestId: 'r2', title, options: [], inputKind: 'text', ...extra })

describe('matchFrame', () => {
  test('Given the radio frame OMP sends, When matched at cursor 0, Then the Other row is found and not treated as an option', () => {
    const match = matchFrame(FIELDS, 0, choice('Which database?', ['Postgres', 'SQLite', 'Other (type your own)']))
    expect(match).toMatchObject({ fieldIndex: 0, optionRows: ['Postgres', 'SQLite'], otherRow: 'Other (type your own)', doneRow: null })
  })

  test('Given the checkbox frame, When matched, Then the Other and Done rows are reported, whichever glyph the Done row carries', () => {
    for (const done of ['✔ Done selecting', '[OK] Done selecting', 'Done selecting']) {
      const match = matchFrame(FIELDS, 1, choice('Which features?', ['Auth', 'Billing', 'Other (type your own)', done]))
      expect(match).toMatchObject({ fieldIndex: 1, optionRows: ['Auth', 'Billing'], otherRow: 'Other (type your own)', doneRow: done })
    }
  })

  test('Given a checkbox re-prompt with a "(N selected) " title prefix, When matched, Then the prefix is ignored', () => {
    expect(matchFrame(FIELDS, 1, choice('(2 selected) Which features?', ['Auth', 'Billing', 'Other (type your own)', '✔ Done selecting']))).not.toBeNull()
  })

  test('Given case, spacing and a trailing colon differences in the title, When matched, Then the label still matches', () => {
    expect(matchFrame(FIELDS, 2, text('  why?  '))).not.toBeNull()
    const named: AskFormField = { kind: 'text', name: 'n', question: 'Your name:', required: false, defaultValue: '' }
    expect(matchFrame([named], 0, text('your   name'))).not.toBeNull()
  })

  test('Given input and editor frames, When matched against a text or textarea field, Then both match because they arrive as the same text request', () => {
    expect(matchFrame(FIELDS, 2, text('Why?'))).toMatchObject({ fieldIndex: 2, optionRows: [] })
    const area: AskFormField = { kind: 'textarea', name: 'n', question: 'Notes', required: false, defaultValue: '' }
    expect(matchFrame([area], 0, text('Notes'))).not.toBeNull()
  })

  test('Given the option row carries the HTML value rather than the label, When matched, Then it still resolves', () => {
    const field: AskFormField = { kind: 'radio', name: 'r', question: 'Pick', required: false, options: [{ value: 'a', label: 'Alpha' }], defaultValue: [] }
    expect(matchFrame([field], 0, choice('Pick', ['a']))?.optionRows).toEqual(['a'])
  })

  test('Given a checkbox frame that omits an option, When matched, Then the missing option has a null row', () => {
    expect(matchFrame(FIELDS, 1, choice('Which features?', ['Billing', '✔ Done selecting']))?.optionRows).toEqual([null, 'Billing'])
  })

  test.each([
    ['more frames than fields', 3, text('Why?')],
    ['a negative cursor', -1, text('Why?')],
    ['a different label', 0, choice('Which store?', ['Postgres', 'SQLite'])],
    ['a text frame for a choice field', 0, text('Which database?')],
    ['a choice frame for a text field', 2, choice('Why?', ['Because'])],
    ['a radio field fed a Done row', 0, choice('Which database?', ['Postgres', 'SQLite', '✔ Done selecting'])],
    ['a checkbox field with no Done row', 1, choice('Which features?', ['Auth', 'Billing'])],
    ['an option the form does not have', 0, choice('Which database?', ['Postgres', 'MySQL'])],
    ['a secret input', 2, text('Why?', { secret: true })],
    ['a confirm frame', 0, { kind: 'question', requestId: 'c', title: 'Which database?', options: ['Yes', 'No'], inputKind: 'confirm' } as Question],
    ['an approval request', 0, { kind: 'approval', requestId: 'a', tool: 'bash', target: 'ls', details: [] } as PendingRequest],
  ])('Given %s, When matched, Then it is a mismatch', (_label, cursor, request) => {
    expect(matchFrame(FIELDS, cursor, request)).toBeNull()
  })

  test('Given two wire rows that both name one option, When matched, Then the second is a mismatch', () => {
    expect(matchFrame(FIELDS, 0, choice('Which database?', ['Postgres', 'Postgres']))).toBeNull()
  })
})

describe('wire row detection', () => {
  test.each(['Other (type your own)', ' other (type your own) '])('isOtherRow accepts %j', (row) => expect(isOtherRow(row)).toBe(true))
  test('isOtherRow rejects an ordinary option', () => expect(isOtherRow('Other')).toBe(false))
  test.each(['Done selecting', '[OK] Done selecting', '✔ Done selecting'])('isDoneRow accepts %j', (row) => expect(isDoneRow(row)).toBe(true))
  test('isDoneRow rejects an ordinary option', () => expect(isDoneRow('Done')).toBe(false))
})

describe('frameBelongsToForm', () => {
  test('Given a frame for a later field, When checked, Then it belongs to the form whatever the cursor', () => {
    expect(frameBelongsToForm(FIELDS, text('Why?'))).toBe(true)
    expect(frameBelongsToForm(FIELDS, choice('(1 selected) Which features?', ['Auth', 'Billing', 'Other (type your own)', 'Done selecting']))).toBe(true)
  })

  test('Given another tool\'s question, When checked, Then it does not belong to the form', () => {
    expect(frameBelongsToForm(FIELDS, choice('Deploy to production?', ['Yes', 'No']))).toBe(false)
    expect(frameBelongsToForm(FIELDS, text('Which database?', { secret: true }))).toBe(false)
  })
})
