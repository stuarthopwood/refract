import { describe, expect, it } from 'vitest'

import { readNumberedAnswers } from './readNumberedAnswers'

const DB = { question: 'Which database?', options: ['Postgres', 'MySQL'] }

const answersOf = (text: string, questions: { question: string; options: string[] }[]) => readNumberedAnswers(text, questions)?.answers

describe('readNumberedAnswers (#1989, #1988)', () => {
  it('reads a picked recommended option back to the live wording and flags it', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres" (recommended).'
    expect(answersOf(text, [DB])).toEqual([{ picks: [{ label: 'Postgres', recommended: true }], typed: '', notes: [] }])
  })

  it('words a pick by the live option its letter names', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: B "my sql".'
    expect(answersOf(text, [DB])?.[0]?.picks).toEqual([{ label: 'MySQL', recommended: false }])
  })

  it('reads typed text separately from the picks', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: B "MySQL". Typed: "or SQLite".'
    expect(answersOf(text, [DB])).toEqual([{ picks: [{ label: 'MySQL', recommended: false }], typed: 'or SQLite', notes: [] }])
  })

  it('maps a note letter to the option label', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres".\n Note on A: use v16 please.'
    expect(answersOf(text, [DB])?.[0]?.notes).toEqual([{ option: 'Postgres', text: 'use v16 please' }])
  })

  it('reads an unanswered question as no picks and no typed text', () => {
    const text = 'The developer answered 1 question.\n1. Which database? No answer.'
    expect(answersOf(text, [DB])).toEqual([{ picks: [], typed: '', notes: [] }])
  })

  it('still finds a question longer than a note whose line breaks the host flattened', () => {
    const long = `${'q'.repeat(1200)}\nsecond line`
    const flat = `${'q'.repeat(1200)} second line`
    const text = `The developer answered 1 question.\n1. ${flat} Picked: A "Postgres".`
    expect(answersOf(text, [{ question: long, options: ['Postgres'] }])?.[0]?.picks).toEqual([{ label: 'Postgres', recommended: false }])
  })

  it('matches a question carrying Unicode line breaks and bidi characters', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres".'
    const question = { question: 'Which\u2028data\u202Ebase?', options: ['Postgres'] }
    expect(answersOf(text, [question])?.[0]?.picks).toEqual([{ label: 'Postgres', recommended: false }])
  })

  it('returns undefined for text that is not a numbered result', () => {
    expect(readNumberedAnswers('Some other output', [DB])).toBeUndefined()
    expect(readNumberedAnswers('The developer cancelled the questions.', [DB])).toBeUndefined()
    expect(readNumberedAnswers(undefined, [DB])).toBeUndefined()
  })

  it('reads every question of a two-question result', () => {
    const text = 'The developer answered 2 questions.\n1. Which database? Picked: A "Postgres".\n2. Which cache? Picked: B "Redis".'
    const cache = { question: 'Which cache?', options: ['Memcached', 'Redis'] }
    expect(answersOf(text, [DB, cache])?.map((answer) => answer.picks[0]?.label)).toEqual(['Postgres', 'Redis'])
  })

  it('names a note on a label the question never offered by that label', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres".\n Note on "Odd label": keep it.'
    expect(answersOf(text, [DB])?.[0]?.notes).toEqual([{ option: 'Odd label', text: 'keep it' }])
  })

  it('reads a pick that carries no letter', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: "Postgres".'
    expect(answersOf(text, [DB])?.[0]?.picks).toEqual([{ label: 'Postgres', recommended: false }])
  })

  it('reads the developer as the answerer unless the result opens with Away Mode', () => {
    const human = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres".'
    const away = 'Away Mode answered 1 question.\n1. Which database? Picked: A "Postgres".'
    expect(readNumberedAnswers(human, [DB])?.byAway).toBe(false)
    expect(readNumberedAnswers(away, [DB])?.byAway).toBe(true)
  })

  it('reads picks, typed text and notes of an Away Mode result the same way', () => {
    const text = 'Away Mode answered 1 question.\n1. Which database? Picked: A "Postgres" (recommended). Typed: "and SQLite".\n Note on A: use v16 please.'
    expect(readNumberedAnswers(text, [DB])).toEqual({
      byAway: true,
      answers: [{ picks: [{ label: 'Postgres', recommended: true }], typed: 'and SQLite', notes: [{ option: 'Postgres', text: 'use v16 please' }] }]
    })
  })

  it('reads every pick of a multiple-choice answer and a note on each', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres" (recommended), B "MySQL".\n Note on A: primary.\n Note on B: legacy.'
    const answer = answersOf(text, [DB])?.[0]
    expect(answer?.picks).toEqual([
      { label: 'Postgres', recommended: true },
      { label: 'MySQL', recommended: false }
    ])
    expect(answer?.notes).toEqual([
      { option: 'Postgres', text: 'primary' },
      { option: 'MySQL', text: 'legacy' }
    ])
  })

  it('does not read Away Mode from a result that only mentions it later', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Typed: "Away Mode answered 1 question.".'
    expect(readNumberedAnswers(text, [DB])?.byAway).toBe(false)
  })
})
