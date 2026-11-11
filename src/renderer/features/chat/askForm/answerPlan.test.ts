import { describe, expect, test } from 'vitest'
import { type AskFieldValue, canSubmit, initialValue, isAnswered, planSteps, resolveStep } from './answerPlan'
import { matchFrame } from './matchFrame'
import type { AskFormField } from './parseAskHtml'

const radio: AskFormField = { kind: 'radio', name: 'db', question: 'Which database?', required: false, options: [{ value: 'pg', label: 'Postgres' }, { value: 'lite', label: 'SQLite' }], defaultValue: [] }
const checkbox: AskFormField = { kind: 'checkbox', name: 'f', question: 'Which features?', required: false, options: [{ value: 'a', label: 'Auth' }, { value: 'b', label: 'Billing' }], defaultValue: [] }
const text: AskFormField = { kind: 'text', name: 'why', question: 'Why?', required: false, defaultValue: '' }

const choice = (selected: string[], otherSelected = false, otherText = ''): AskFieldValue => ({ kind: 'choice', selected, otherSelected, otherText })

describe('planSteps', () => {
  test('Given a radio group with a pick, When planned, Then one step answers that option by index', () => {
    expect(planSteps(radio, choice(['lite']))).toEqual([{ kind: 'option', index: 1 }])
  })

  test('Given a checkbox group with picks, When planned, Then each chosen row is toggled and Done selecting follows automatically', () => {
    expect(planSteps(checkbox, choice(['a', 'b']))).toEqual([{ kind: 'option', index: 0 }, { kind: 'option', index: 1 }, { kind: 'done' }])
  })

  test('Given an empty checkbox group, When planned, Then only Done selecting is sent', () => {
    expect(planSteps(checkbox, choice([]))).toEqual([{ kind: 'done' }])
  })

  test('Given Other with text on a radio group, When planned, Then the Other row is chosen and its text follows', () => {
    expect(planSteps(radio, choice([], true, '  Mongo  '))).toEqual([{ kind: 'other' }, { kind: 'otherText', text: 'Mongo' }])
  })

  test('Given Other plus a pick on a checkbox group, When planned, Then picks come first, then Other and its text, then Done', () => {
    expect(planSteps(checkbox, choice(['a'], true, 'Tax'))).toEqual([
      { kind: 'option', index: 0 },
      { kind: 'other' },
      { kind: 'otherText', text: 'Tax' },
      { kind: 'done' }
    ])
  })

  test('Given an Other choice with an empty text box, When planned, Then it counts as unanswered and adds no step', () => {
    expect(planSteps(checkbox, choice([], true, '   '))).toEqual([{ kind: 'done' }])
    expect(planSteps(radio, choice([], true, ''))).toEqual([])
  })

  test('Given a radio group with nothing chosen, When planned, Then no step exists because OMP has no "none" row', () => {
    expect(planSteps(radio, choice([]))).toEqual([])
  })

  test('Given a text field, When planned, Then its trimmed text is the one step', () => {
    expect(planSteps(text, { kind: 'text', text: '  because  ' })).toEqual([{ kind: 'text', text: 'because' }])
  })
})

describe('isAnswered and canSubmit', () => {
  test('Given an Other choice with an empty text box, When checked, Then it is unanswered', () => {
    expect(isAnswered(choice([], true, ' '))).toBe(false)
    expect(isAnswered(choice([], true, 'x'))).toBe(true)
  })

  test('Given required fields, When one is unanswered, Then Submit is blocked until it is filled', () => {
    const fields: AskFormField[] = [{ ...radio, required: true }, { ...text, required: true }, checkbox]
    const values = [choice([]), { kind: 'text', text: '' } as const, choice([])]
    expect(canSubmit(fields, values)).toBe(false)
    expect(canSubmit(fields, [choice(['pg']), { kind: 'text', text: '' }, choice([])])).toBe(false)
    expect(canSubmit(fields, [choice(['pg']), { kind: 'text', text: 'y' }, choice([])])).toBe(true)
  })

  test('Given fields not marked required, When all are blank, Then Submit is allowed', () => {
    expect(canSubmit([radio, checkbox, text], [radio, checkbox, text].map(initialValue))).toBe(true)
  })

  test('Given a required Other-only radio with empty text, When checked, Then Submit stays blocked', () => {
    expect(canSubmit([{ ...radio, required: true }], [choice([], true, '')])).toBe(false)
  })
})

describe('resolveStep', () => {
  const match = matchFrame([checkbox], 0, { kind: 'question', requestId: 'r', title: 'Which features?', options: ['Auth', 'Billing', 'Other (type your own)', '✔ Done selecting'], inputKind: 'choice' })

  test('Given a matched checkbox frame, When steps resolve, Then each answer is the exact wire row', () => {
    expect(resolveStep({ kind: 'option', index: 1 }, match)).toEqual({ value: 'Billing' })
    expect(resolveStep({ kind: 'other' }, match)).toEqual({ value: 'Other (type your own)' })
    expect(resolveStep({ kind: 'done' }, match)).toEqual({ value: '✔ Done selecting' })
  })

  test('Given a frame lacking the row, When resolved, Then null so the caller falls back', () => {
    const bare = matchFrame([radio], 0, { kind: 'question', requestId: 'r', title: 'Which database?', options: ['Postgres', 'SQLite'], inputKind: 'choice' })
    expect(resolveStep({ kind: 'other' }, bare)).toBeNull()
    expect(resolveStep({ kind: 'done' }, bare)).toBeNull()
  })

  test('Given text steps, When resolved, Then the text is sent with no frame needed', () => {
    expect(resolveStep({ kind: 'text', text: 'hi' }, null)).toEqual({ value: 'hi' })
    expect(resolveStep({ kind: 'otherText', text: 'Mongo' }, null)).toEqual({ value: 'Mongo' })
  })
})
