import { describe, expect, test } from 'vitest'
import type { PendingRequest } from '../../../../shared/model'
import { afterAnswered, type AskFormSession, initialSession, nextAction } from './askFormSession'
import type { AskFormField } from './parseAskHtml'

const FIELDS: AskFormField[] = [
  { kind: 'radio', name: 'db', question: 'Which database?', required: false, options: [{ value: 'pg', label: 'Postgres' }, { value: 'lite', label: 'SQLite' }], defaultValue: [] },
  { kind: 'checkbox', name: 'f', question: 'Which features?', required: false, options: [{ value: 'a', label: 'Auth' }, { value: 'b', label: 'Billing' }], defaultValue: [] },
  { kind: 'text', name: 'why', question: 'Why?', required: false, defaultValue: '' }
]

type Question = Extract<PendingRequest, { kind: 'question' }>
const frame = (requestId: string, title: string, options: string[], inputKind: Question['inputKind'] = 'choice'): Question => ({ kind: 'question', requestId, title, options, inputKind })

const dbFrame = (id = 'r1') => frame(id, 'Which database?', ['Postgres', 'SQLite', 'Other (type your own)'])
const featuresFrame = (id = 'r2') => frame(id, 'Which features?', ['Auth', 'Billing', 'Other (type your own)', '✔ Done selecting'])
const whyFrame = (id = 'r3') => frame(id, 'Why?', [], 'text')

function filled(): AskFormSession {
  const base = initialSession(FIELDS)
  return {
    ...base,
    values: [
      { kind: 'choice', selected: ['lite'], otherSelected: false, otherText: '' },
      { kind: 'choice', selected: ['a', 'b'], otherSelected: false, otherText: '' },
      { kind: 'text', text: 'because' }
    ]
  }
}

describe('nextAction while editing', () => {
  test('Given the first frame matches field 0, When the user has not submitted, Then nothing is answered', () => {
    expect(nextAction(filled(), FIELDS, [dbFrame()])).toEqual({ type: 'none' })
  })

  test('Given the first frame does not match field 0, When it arrives, Then the card falls back to per-field cards', () => {
    expect(nextAction(filled(), FIELDS, [frame('r1', 'Something else?', ['x', 'y'])])).toEqual({ type: 'fallback' })
  })

  test('Given no frame yet, When editing, Then nothing happens', () => {
    expect(nextAction(filled(), FIELDS, [])).toEqual({ type: 'none' })
  })
})

describe('in-order answering after Submit', () => {
  test('Given Submit, When each frame arrives in order, Then the card answers every step and ends done', () => {
    let session: AskFormSession = { ...filled(), phase: 'answering' }
    const sent: unknown[] = []
    const run = (pending: Question[]) => {
      const action = nextAction(session, FIELDS, pending)
      if (action.type !== 'send') throw new Error(`expected send, got ${action.type}`)
      sent.push(action.answer)
      session = afterAnswered(session, FIELDS, action.requestId, action.answer)
    }

    run([dbFrame()])
    // The checkbox group is re-prompted after each toggle, so the same field's frames repeat.
    run([featuresFrame('r2')])
    run([frame('r3', '(1 selected) Which features?', ['Auth', 'Billing', 'Other (type your own)', '✔ Done selecting'])])
    run([frame('r4', '(2 selected) Which features?', ['Auth', 'Billing', 'Other (type your own)', '✔ Done selecting'])])
    run([whyFrame('r5')])

    expect(sent).toEqual([{ value: 'SQLite' }, { value: 'Auth' }, { value: 'Billing' }, { value: '✔ Done selecting' }, { value: 'because' }])
    expect(session.phase).toBe('done')
  })

  test('Given a frame already answered, When the pending list still lists it, Then it is not answered twice', () => {
    const session: AskFormSession = { ...filled(), phase: 'answering', handled: ['r1'] }
    expect(nextAction(session, FIELDS, [dbFrame('r1')])).toEqual({ type: 'none' })
  })

  test('Given a request in flight, When another poll runs, Then nothing is sent twice', () => {
    expect(nextAction({ ...filled(), phase: 'answering', inflight: 'r1' }, FIELDS, [dbFrame()])).toEqual({ type: 'none' })
  })

  test('Given Other text on a radio field, When the free-text frame arrives, Then its text is sent without a label match', () => {
    const base = filled()
    const session: AskFormSession = {
      ...base,
      phase: 'answering',
      stepIndex: 1,
      values: [{ kind: 'choice', selected: [], otherSelected: true, otherText: 'Mongo' }, ...base.values.slice(1)]
    }
    expect(nextAction(session, FIELDS, [frame('r2', 'Enter your answer', [], 'text')])).toEqual({ type: 'send', requestId: 'r2', answer: { value: 'Mongo' } })
  })

  test('Given a frame for the wrong field mid-sequence, When it arrives, Then the remaining fields fall back', () => {
    const session: AskFormSession = { ...filled(), phase: 'answering', cursor: 1 }
    expect(nextAction(session, FIELDS, [whyFrame()])).toEqual({ type: 'fallback' })
  })

  test('Given every field answered, When a further frame arrives, Then it is not part of the form and falls back', () => {
    expect(nextAction({ ...filled(), phase: 'done' }, FIELDS, [whyFrame()])).toEqual({ type: 'fallback' })
  })

  test('Given a radio group with nothing chosen, When its frame arrives after Submit, Then it falls back rather than guessing', () => {
    expect(nextAction({ ...initialSession(FIELDS), phase: 'answering' }, FIELDS, [dbFrame()])).toEqual({ type: 'fallback' })
  })

  test('Given a fallback phase, When frames arrive, Then the card sends nothing', () => {
    expect(nextAction({ ...filled(), phase: 'fallback' }, FIELDS, [dbFrame()])).toEqual({ type: 'none' })
  })
})

describe('Cancel', () => {
  test('Given Cancel, When frames are pending now or arrive later, Then each one is cancelled in turn', () => {
    let session: AskFormSession = { ...filled(), phase: 'cancelling' }
    const pending = [dbFrame('r1'), featuresFrame('r2')]
    const first = nextAction(session, FIELDS, pending)
    expect(first).toEqual({ type: 'send', requestId: 'r1', answer: { cancelled: true } })
    session = afterAnswered(session, FIELDS, 'r1', { cancelled: true })
    expect(session.phase).toBe('cancelling')
    expect(nextAction(session, FIELDS, pending)).toEqual({ type: 'send', requestId: 'r2', answer: { cancelled: true } })
  })

  test('Given Cancel, When a frame matches nothing in the form, Then it is still cancelled, not shown as a card', () => {
    expect(nextAction({ ...filled(), phase: 'cancelling' }, FIELDS, [frame('x', 'Unrelated', ['a'])])).toMatchObject({ type: 'send', answer: { cancelled: true } })
  })
})

describe('afterAnswered', () => {
  test('Given an accepted answer, When recorded, Then the frame is handled and the step advances', () => {
    const next = afterAnswered({ ...filled(), phase: 'answering', cursor: 1 }, FIELDS, 'r2', { value: 'Auth' })
    expect(next).toMatchObject({ cursor: 1, stepIndex: 1, handled: ['r2'], inflight: null })
  })
})
