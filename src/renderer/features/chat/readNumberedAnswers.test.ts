import { describe, expect, it } from 'vitest'

import { readNumberedAnswers } from './readNumberedAnswers'

const DB = { question: 'Which database?', options: ['Postgres', 'MySQL'] }

describe('readNumberedAnswers (#1989)', () => {
  it('reads a picked recommended option back to the live wording', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres" (recommended).'
    expect(readNumberedAnswers(text, [DB])).toEqual(['Postgres'])
  })

  it('reads typed text as Other and joins it after the picks', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: B "MySQL". Typed: "or SQLite".'
    expect(readNumberedAnswers(text, [DB])).toEqual(['MySQL, Other: or SQLite'])
  })

  it('maps a note letter to the option label and keeps the note on its own line', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres".\n Note on A: use v16 please.'
    expect(readNumberedAnswers(text, [DB])).toEqual(['Postgres\nNote on Postgres: use v16 please'])
  })

  it('reads an unanswered question as None selected', () => {
    const text = 'The developer answered 1 question.\n1. Which database? No answer.'
    expect(readNumberedAnswers(text, [DB])).toEqual(['None selected'])
  })

  it('still finds a question longer than a note whose line breaks the host flattened', () => {
    const long = `${'q'.repeat(1200)}\nsecond line`
    const flat = `${'q'.repeat(1200)} second line`
    const text = `The developer answered 1 question.\n1. ${flat} Picked: A "Postgres".`
    expect(readNumberedAnswers(text, [{ question: long, options: ['Postgres'] }])).toEqual(['Postgres'])
  })

  it('matches a question carrying Unicode line breaks and bidi characters', () => {
    const text = 'The developer answered 1 question.\n1. Which database? Picked: A "Postgres".'
    const question = { question: 'Which\u2028data\u202Ebase?', options: ['Postgres'] }
    expect(readNumberedAnswers(text, [question])).toEqual(['Postgres'])
  })

  it('returns undefined for text that is not a numbered result', () => {
    expect(readNumberedAnswers('Some other output', [DB])).toBeUndefined()
    expect(readNumberedAnswers(undefined, [DB])).toBeUndefined()
  })
})
