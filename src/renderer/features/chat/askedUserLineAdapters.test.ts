import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { askedUserModel } from './askedUserLineAdapters'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

function tool(partial: Partial<ToolItem>): ToolItem {
  return { kind: 'tool', id: 'a1', toolCallId: 'c1', tool: 'refract_ask', target: '', status: 'done', args: undefined, ...partial }
}

const DB_ARGS = { questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres', recommended: true }, { label: 'MySQL' }] }] }

describe('askedUserModel: refract_ask structured results', () => {
  it('Given a picked recommended option, When mapped, Then it is answered and flagged recommended', () => {
    const model = askedUserModel(tool({ args: DB_ARGS, details: { results: [{ id: 'db', selectedOptions: ['Postgres'] }] } }))
    expect(model).toEqual({
      status: 'answered',
      questions: [{ prompt: 'Which database?', multi: false, answers: [{ label: 'Postgres', other: false, recommended: true }] }]
    })
  })

  it('Given typed text beside a pick, When mapped, Then the typed text is an Other answer', () => {
    const model = askedUserModel(tool({ args: DB_ARGS, details: { results: [{ id: 'db', selectedOptions: ['MySQL'], customInput: ' SQLite ' }] } }))
    expect(model.questions[0]?.answers).toEqual([
      { label: 'MySQL', other: false, recommended: false },
      { label: 'SQLite', other: true, recommended: false }
    ])
  })

  it('Given a note on a pick, When mapped, Then the note rides on that pick', () => {
    const model = askedUserModel(tool({ args: DB_ARGS, details: { results: [{ id: 'db', selectedOptions: ['Postgres'], notes: [{ option: 'Postgres', text: 'use v16' }] }] } }))
    expect(model.questions[0]?.answers[0]?.note).toBe('use v16')
  })

  it('Given a result that Away Mode answered, When mapped, Then the status says so', () => {
    const model = askedUserModel(tool({ args: DB_ARGS, details: { results: [{ id: 'db', selectedOptions: ['Postgres'], byAway: true }] } }))
    expect(model.status).toBe('answered-by-away')
  })

  it('Given a timed-out ask, When mapped, Then the status is timed-out', () => {
    const model = askedUserModel(tool({ args: DB_ARGS, details: { results: [{ id: 'db', timedOut: true }] } }))
    expect(model.status).toBe('timed-out')
    expect(model.questions[0]?.answers).toEqual([])
  })

  it('Given a question with no result entry, When mapped, Then it has no answers', () => {
    const args = { questions: [...DB_ARGS.questions, { id: 'cache', question: 'Which cache?', options: ['Redis'] }] }
    const model = askedUserModel(tool({ args, details: { results: [{ id: 'db', selectedOptions: ['MySQL'] }] } }))
    expect(model.questions.map((question) => question.answers.length)).toEqual([1, 0])
  })

  it('Given a multiple-choice question, When mapped, Then the flag carries over', () => {
    const args = { questions: [{ id: 'db', question: 'Which?', multi: true, options: ['A', 'B'] }] }
    expect(askedUserModel(tool({ args, details: { results: [{ id: 'db', selectedOptions: ['A', 'B'] }] } })).questions[0]?.multi).toBe(true)
  })
})

describe('askedUserModel: native ask rows and saved numbered text', () => {
  const nativeArgs = { questions: [{ id: 'db', question: 'Which database?', options: ['Postgres', 'MySQL'], recommended: 0 }] }

  it('Given numbered text, When mapped, Then picks, typed text and notes are read from it', () => {
    const output = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres" (recommended). Typed: "and SQLite".\n Note on A: use v16.'
    const model = askedUserModel(tool({ tool: 'ask', args: nativeArgs, output }))
    expect(model.status).toBe('answered')
    expect(model.questions[0]?.answers).toEqual([
      { label: 'Postgres', other: false, recommended: true, note: 'use v16' },
      { label: 'and SQLite', other: true, recommended: false }
    ])
  })

  it('Given a numbered result that opens with Away Mode, When mapped, Then it reads as answered by Away Mode', () => {
    const output = 'Away Mode answered 1 question.\n1. Which database? Picked: A "Postgres".'
    expect(askedUserModel(tool({ tool: 'ask', args: nativeArgs, output })).status).toBe('answered-by-away')
  })

  it('Given an old transcript without the Away marker, When mapped, Then the developer answered', () => {
    const output = 'The developer answered 1 question.\n1. Which database? Picked: B "MySQL".'
    expect(askedUserModel(tool({ tool: 'ask', args: nativeArgs, output })).status).toBe('answered')
  })

  it('Given the oldest single-question shape, When mapped, Then top-level selectedOptions are the answers', () => {
    const args = { question: 'Which database?', options: ['Postgres', 'MySQL'] }
    const model = askedUserModel(tool({ tool: 'ask', args, details: { selectedOptions: ['MySQL'] } }))
    expect(model.questions[0]).toEqual({ prompt: 'Which database?', multi: false, answers: [{ label: 'MySQL', other: false, recommended: false }] })
  })

  it('Given the oldest shape answered only in the result text, When mapped, Then the text is the answer', () => {
    const args = { question: 'Which database?', options: ['Postgres'] }
    expect(askedUserModel(tool({ tool: 'ask', args, output: 'Postgres' })).questions[0]?.answers[0]?.label).toBe('Postgres')
  })

  it('Given a cancelled result, When mapped, Then the status is cancelled and no question has an answer', () => {
    const model = askedUserModel(tool({ tool: 'ask', args: nativeArgs, output: 'The developer cancelled the questions.' }))
    expect(model.status).toBe('cancelled')
    expect(model.questions[0]?.answers).toEqual([])
  })

  it('Given a stopped call, When mapped, Then the status is not-answered', () => {
    expect(askedUserModel(tool({ tool: 'ask', args: nativeArgs, status: 'interrupted' })).status).toBe('not-answered')
  })

  it('Given a tool error, When mapped, Then the status is cancelled', () => {
    expect(askedUserModel(tool({ tool: 'ask', args: nativeArgs, status: 'error' })).status).toBe('cancelled')
  })
})

describe('askedUserModel: HTML-form ask', () => {
  const html = '<fieldset><legend>Which language?</legend><label><input type="radio" name="lang" value="TS">TS</label></fieldset>'

  it('Given saved answer rows, When mapped, Then each row is one question with one plain answer', () => {
    const details = { answers: [{ name: 'lang', question: 'Which language?', answer: 'TS' }] }
    const model = askedUserModel(tool({ tool: 'ask', args: { html }, details }))
    expect(model).toEqual({
      status: 'answered',
      questions: [{ prompt: 'Which language?', multi: false, answers: [{ label: 'TS', other: false, recommended: false }] }]
    })
  })

  it('Given a blank saved answer, When mapped, Then the question has no answer', () => {
    const details = { answers: [{ name: 'lang', question: 'Which language?', answer: ' ' }] }
    expect(askedUserModel(tool({ tool: 'ask', args: { html }, details })).questions[0]?.answers).toEqual([])
  })

  it('Given a cancelled form, When mapped, Then the status is cancelled and answers are dropped', () => {
    const details = { answers: [{ name: 'lang', question: 'Which language?', answer: 'TS' }] }
    const model = askedUserModel(tool({ tool: 'ask', args: { html }, details, output: 'The developer cancelled the questions.' }))
    expect(model.status).toBe('cancelled')
    expect(model.questions[0]?.answers).toEqual([])
  })

  it('Given no saved answers, When mapped, Then the form fields supply the questions with no answer', () => {
    const model = askedUserModel(tool({ tool: 'ask', args: { html }, status: 'interrupted' }))
    expect(model.status).toBe('not-answered')
    expect(model.questions.map((question) => question.prompt)).toEqual(['Which language?'])
  })
})
