import { describe, expect, it } from 'vitest'
import { bodyAddsContent, firstLineSummary, meaningfulLines } from './midTurnProseText'

describe('meaningfulLines', () => {
  it('skips blank, fence and rule lines', () => {
    expect(meaningfulLines('one\n\n```\n---\n* * *\ntwo')).toEqual(['one', 'two'])
  })
})

describe('bodyAddsContent (#1875)', () => {
  describe('given a one-line note', () => {
    it('adds nothing', () => expect(bodyAddsContent('Checking the build.')).toBe(false))
  })
  describe('given one line plus a code fence', () => {
    it('adds nothing', () => expect(bodyAddsContent('Checking the build.\n```\n')).toBe(false))
  })
  describe('given two meaningful lines', () => {
    it('adds content', () => expect(bodyAddsContent('Checking the build.\nThen the tests.')).toBe(true))
  })
  describe('given bold-only text', () => {
    it('adds nothing even though the summary differs from the text', () => {
      expect(firstLineSummary('**done**')).toBe('done')
      expect(bodyAddsContent('**done**')).toBe(false)
    })
  })
})
