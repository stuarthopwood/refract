import { describe, expect, test } from 'vitest'
import type { PendingRequest } from '../../../../shared/model'
import { afterAnswered, afterSendFailed, canCancel, cancelSession, type AskFormSession, initialSession, nextAction, submitSession } from './askFormSession'
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
    expect(nextAction(session, FIELDS, [frame('r2', 'Which database?', [], 'text')])).toEqual({ type: 'send', requestId: 'r2', answer: { value: 'Mongo' } })
  })

  test('Given a frame for the wrong field mid-sequence, When it arrives, Then the remaining fields fall back', () => {
    const session: AskFormSession = { ...filled(), phase: 'answering', cursor: 1 }
    expect(nextAction(session, FIELDS, [whyFrame()])).toEqual({ type: 'fallback' })
  })

  test('Given every field answered, When a further frame arrives, Then it is not part of the form and falls back', () => {
    expect(nextAction({ ...filled(), phase: 'done' }, FIELDS, [whyFrame()])).toEqual({ type: 'fallback' })
  })

  test('Given Other text pending, When a non-text frame arrives instead, Then the remaining frames fall back', () => {
    const base = filled()
    const session: AskFormSession = {
      ...base,
      phase: 'answering',
      stepIndex: 1,
      values: [{ kind: 'choice', selected: [], otherSelected: true, otherText: 'Mongo' }, ...base.values.slice(1)]
    }
    expect(nextAction(session, FIELDS, [dbFrame('r2')])).toEqual({ type: 'fallback' })
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

  test('Given Cancel, When another tool\'s question is pending, Then it is left alone', () => {
    expect(nextAction({ ...filled(), phase: 'cancelling' }, FIELDS, [frame('x', 'Deploy to production?', ['Yes', 'No'])])).toEqual({ type: 'none' })
  })

  test('Given Cancel, When another tool\'s question precedes this form\'s frame, Then only this form\'s frame is cancelled', () => {
    const pending = [frame('x', 'Deploy to production?', ['Yes', 'No']), dbFrame('r1')]
    expect(nextAction({ ...filled(), phase: 'cancelling' }, FIELDS, pending)).toEqual({ type: 'send', requestId: 'r1', answer: { cancelled: true } })
  })

  test('Given Cancel after Other was chosen, When OMP asks for the Other text, Then that free-text frame is cancelled too', () => {
    const base = filled()
    const session: AskFormSession = {
      ...base,
      phase: 'cancelling',
      stepIndex: 1,
      values: [{ kind: 'choice', selected: [], otherSelected: true, otherText: 'Mongo' }, ...base.values.slice(1)]
    }
    expect(nextAction(session, FIELDS, [frame('r2', 'Which database?', [], 'text')])).toEqual({ type: 'send', requestId: 'r2', answer: { cancelled: true } })
  })
})

describe('afterAnswered', () => {
  test('Given an accepted answer, When recorded, Then the frame is handled and the step advances', () => {
    const next = afterAnswered({ ...filled(), phase: 'answering', cursor: 1 }, FIELDS, 'r2', { value: 'Auth' })
    expect(next).toMatchObject({ cursor: 1, stepIndex: 1, handled: ['r2'], inflight: null })
  })

  test('Given a cancelled answer accepted while answering, When recorded, Then the frame is handled but the step does not advance', () => {
    const next = afterAnswered({ ...filled(), phase: 'answering', cursor: 1, stepIndex: 1 }, FIELDS, 'r2', { cancelled: true })
    expect(next).toMatchObject({ phase: 'answering', cursor: 1, stepIndex: 1, handled: ['r2'], inflight: null })
  })
})

describe('Other on a checkbox group', () => {
  test('Given a pick plus Other text, When each frame arrives in order, Then option, Other, its text and Done are sent and the cursor moves on', () => {
    const base = filled()
    let session: AskFormSession = {
      ...base,
      phase: 'answering',
      cursor: 1,
      values: [base.values[0]!, { kind: 'choice', selected: ['a'], otherSelected: true, otherText: 'Tax' }, base.values[2]!]
    }
    const sent: unknown[] = []
    const run = (request: Question) => {
      const action = nextAction(session, FIELDS, [request])
      if (action.type !== 'send') throw new Error(`expected send, got ${action.type}`)
      sent.push(action.answer)
      session = afterAnswered(session, FIELDS, action.requestId, action.answer)
    }
    const rows = ['Auth', 'Billing', 'Other (type your own)', '✔ Done selecting']

    run(frame('r1', 'Which features?', rows))
    run(frame('r2', '(1 selected) Which features?', rows))
    run(frame('r3', 'Which features?', [], 'text'))
    run(frame('r4', '(2 selected) Which features?', rows))

    expect(sent).toEqual([{ value: 'Auth' }, { value: 'Other (type your own)' }, { value: 'Tax' }, { value: '✔ Done selecting' }])
    expect(session).toMatchObject({ phase: 'answering', cursor: 2, stepIndex: 0 })
  })
})

describe('Submit rule', () => {
  test('Given a radio group with nothing chosen, When Submit is pressed, Then the session stays editing', () => {
    const blank = initialSession(FIELDS)
    expect(submitSession(blank, FIELDS)).toBe(blank)
  })

  test('Given every radio group answered, When Submit is pressed, Then the session starts answering', () => {
    expect(submitSession(initialSession(FIELDS), FIELDS).phase).toBe('editing')
    expect(submitSession(filled(), FIELDS)).toMatchObject({ phase: 'answering', error: null })
  })

  test('Given a session that is already answering, When Submit is pressed again, Then nothing changes', () => {
    const answering: AskFormSession = { ...filled(), phase: 'answering' }
    expect(submitSession(answering, FIELDS)).toBe(answering)
  })
})

describe('failed sends', () => {
  test('Given a failed answer while answering, When recorded, Then the form is editable again with the error', () => {
    expect(afterSendFailed({ ...filled(), phase: 'answering', inflight: 'r1' }, 'offline')).toMatchObject({ phase: 'editing', inflight: null, error: 'offline' })
  })

  test('Given a failed cancel, When recorded, Then the session stays cancelling and does not resend on its own', () => {
    const failed = afterSendFailed({ ...filled(), phase: 'cancelling', inflight: 'r1' }, 'offline')
    expect(failed).toMatchObject({ phase: 'cancelling', inflight: null, error: 'offline' })
    expect(nextAction(failed, FIELDS, [dbFrame('r1')])).toEqual({ type: 'none' })
  })

  test('Given a failed cancel, When the user cancels again, Then the retry clears the error and cancels the frame', () => {
    const failed = afterSendFailed({ ...filled(), phase: 'cancelling', inflight: 'r1' }, 'offline')
    expect(canCancel(failed)).toBe(true)
    const retry = cancelSession(failed)
    expect(retry).toMatchObject({ phase: 'cancelling', error: null })
    expect(nextAction(retry, FIELDS, [dbFrame('r1')])).toMatchObject({ type: 'send', answer: { cancelled: true } })
  })

  test('Given a cancel that succeeded, When asked again, Then Cancel is not offered', () => {
    expect(canCancel({ ...filled(), phase: 'cancelling' })).toBe(false)
    expect(canCancel({ ...filled(), phase: 'done' })).toBe(false)
  })
})
