import { describe, expect, test } from 'vitest'
import { isAskTimedOut, readAskForm } from './readAskForm'

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
