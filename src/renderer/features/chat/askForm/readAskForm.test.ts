import { describe, expect, test } from 'vitest'
import { isAskTimedOut, readAskForm, readAskFormAnswers } from './readAskForm'

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

  test('Given html with a select or a number input, When read, Then null keeps those forms off the per-field path', () => {
    expect(readAskForm({ html: '<select name="s"><option>a</option><option>b</option></select>' })).toBeNull()
    expect(readAskForm({ html: '<input type="text" name="t"><input type="number" name="n">' })).toBeNull()
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

  test('Given an empty or blank answer, When read, Then the row carries an empty answer for the line to show as no answer', () => {
    const rows = readAskFormAnswers({ answers: [{ name: 'a', question: 'Q1', answer: '' }, { name: 'b', question: 'Q2', answer: '  ' }, { name: 'c', question: 'Q3' }] })
    expect(rows?.map((row) => row.answer)).toEqual(['', '', ''])
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
