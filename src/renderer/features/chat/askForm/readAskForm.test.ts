import { describe, expect, test } from 'vitest'
import { askCardLabel, isAskTimedOut, readAskForm, readAskFormAnswers } from './readAskForm'

describe('readAskForm', () => {
  test('Given ask args carrying html, When read, Then the parsed fields come back', () => {
    const fields = readAskForm({ html: '<fieldset><legend>Project name</legend><input type="text" name="p"></fieldset>' })
    expect(fields).toHaveLength(1)
    expect(fields?.[0]).toMatchObject({ kind: 'text', name: 'p', question: 'Project name' })
  })

  test('Given args without html or not an object, When read, Then null keeps today\'s per-field path', () => {
    expect(readAskForm({ question: 'Which?', options: ['a'] })).toBeNull()
    expect(readAskForm(undefined)).toBeNull()
    expect(readAskForm('html')).toBeNull()
  })
})

describe('isAskTimedOut', () => {
  test('Given a top-level or per-result timedOut flag, When checked, Then it is a timeout', () => {
    expect(isAskTimedOut({ timedOut: true })).toBe(true)
    expect(isAskTimedOut({ results: [{ id: 'a' }, { id: 'b', timedOut: true }] })).toBe(true)
  })

  test('Given a normal answer, When checked, Then it is not a timeout', () => {
    expect(isAskTimedOut({ results: [{ id: 'a', timedOut: false }] })).toBe(false)
    expect(isAskTimedOut(undefined)).toBe(false)
    expect(isAskTimedOut({ timedOut: 'yes' })).toBe(false)
  })
})

describe('readAskFormAnswers', () => {
  test('Given details.answers, When read, Then each {name, question, answer} becomes a row', () => {
    const rows = readAskFormAnswers({ answers: [{ name: 'lang', question: 'Which language?', answer: 'TypeScript' }] })
    expect(rows).toEqual([{ name: 'lang', question: 'Which language?', answer: 'TypeScript' }])
  })

  test('Given an empty or blank answer, When read, Then it reads "No selection"', () => {
    const rows = readAskFormAnswers({ answers: [{ name: 'a', question: 'Q1', answer: '' }, { name: 'b', question: 'Q2', answer: '  ' }, { name: 'c', question: 'Q3' }] })
    expect(rows?.map((row) => row.answer)).toEqual(['No selection', 'No selection', 'No selection'])
  })

  test('Given a missing question, When read, Then the field name stands in for it', () => {
    expect(readAskFormAnswers({ answers: [{ name: 'lang', answer: 'x' }] })?.[0]?.question).toBe('lang')
  })

  test('Given entries that are not answer records, When read, Then they are skipped', () => {
    expect(readAskFormAnswers({ answers: [null, 'x', {}, { name: 'a', question: 'Q', answer: 'y' }] })).toHaveLength(1)
  })

  test('Given details without a usable answers list, When read, Then null', () => {
    expect(readAskFormAnswers(undefined)).toBeNull()
    expect(readAskFormAnswers({ results: [] })).toBeNull()
    expect(readAskFormAnswers({ answers: [] })).toBeNull()
    expect(readAskFormAnswers({ answers: 'x' })).toBeNull()
  })
})

describe('askCardLabel', () => {
  test('Given finished cards with different first questions, When named, Then each name carries its own first question', () => {
    const a = askCardLabel([{ name: 'a', question: 'Which database?', answer: 'pg' }])
    const b = askCardLabel([{ name: 'b', question: 'Why?', answer: 'x' }])
    expect(a).toBe('Questions from the agent: Which database?')
    expect(a).not.toBe(b)
  })

  test('Given a long multi-line first question, When named, Then whitespace collapses and the name is truncated', () => {
    const label = askCardLabel([{ name: 'a', question: `line one\n${'x'.repeat(200)}`, answer: 'y' }])
    expect(label.startsWith('Questions from the agent: line one xxx')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThan(120)
  })

  test('Given no usable question, When named, Then the generic name stands in', () => {
    expect(askCardLabel([])).toBe('Questions from the agent')
  })
})
