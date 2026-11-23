import { describe, expect, it } from 'vitest'
import {
  ASKED_USER_TITLE,
  askedUserDigestAnswer,
  askedUserDigestPrompt,
  askedUserHasRecommended,
  askedUserHeader,
  askedUserLabel,
  askedUserNotes,
  NO_ANSWER,
  type AskedUserAnswer,
  type AskedUserLineModel,
  type AskedUserQuestion,
  type AskedUserStatus
} from './askedUserLine'

const pick = (label: string, extra: Partial<AskedUserAnswer> = {}): AskedUserAnswer => ({ label, other: false, recommended: false, ...extra })
const question = (prompt: string, answers: AskedUserAnswer[] = [pick('Postgres')], multi = false): AskedUserQuestion => ({ prompt, multi, answers })
const model = (status: AskedUserStatus, questions: AskedUserQuestion[] = [question('Which database?')]): AskedUserLineModel => ({ status, questions })

describe('askedUserHeader (FR-139)', () => {
  it('counts the questions of an answered ask', () => {
    expect(askedUserHeader(model('answered', [question('A?'), question('B?')]))).toBe(`${ASKED_USER_TITLE} · 2 answered`)
  })

  it('names Away Mode when it answered', () => {
    expect(askedUserHeader(model('answered-by-away', [question('A?'), question('B?'), question('C?')]))).toBe(`${ASKED_USER_TITLE} · 3 answered by Away Mode`)
  })

  it('reads cancelled without a count', () => {
    expect(askedUserHeader(model('cancelled', [question('A?', [])]))).toBe(`${ASKED_USER_TITLE} · cancelled`)
  })

  it('reads a timeout that applied answers as such', () => {
    expect(askedUserHeader(model('timed-out'))).toBe(`${ASKED_USER_TITLE} · timed out, recommended answers applied`)
  })

  it('does not claim applied answers when a timeout left every question empty', () => {
    expect(askedUserHeader(model('timed-out', [question('A?', [])]))).toBe(`${ASKED_USER_TITLE} · timed out`)
  })

  it('reads an ask the Session stopped under as not answered', () => {
    expect(askedUserHeader(model('not-answered', [question('A?', [])]))).toBe(`${ASKED_USER_TITLE} · not answered`)
  })
})

describe('askedUserDigestPrompt', () => {
  it('keeps a one-line prompt as it is', () => {
    expect(askedUserDigestPrompt('Which database?')).toBe('Which database?')
  })

  it('digests a multi-line prompt to its first non-empty line', () => {
    expect(askedUserDigestPrompt('\n  \nWhich database?\nPostgres is the default.')).toBe('Which database?')
  })

  it('collapses runs of whitespace and handles CRLF', () => {
    expect(askedUserDigestPrompt('Which   database\t to\tuse?\r\nSecond')).toBe('Which database to use?')
  })

  it('is empty for a blank prompt', () => {
    expect(askedUserDigestPrompt(' \n ')).toBe('')
  })
})

describe('askedUserDigestAnswer', () => {
  it('joins every pick of a multiple-choice question', () => {
    expect(askedUserDigestAnswer(question('Which?', [pick('A'), pick('B')], true))).toBe('A, B')
  })

  it('shows typed Other text as the answer', () => {
    expect(askedUserDigestAnswer(question('Which?', [pick('or SQLite', { other: true })]))).toBe('or SQLite')
  })

  it('reads no answer for a question without answers', () => {
    expect(askedUserDigestAnswer(question('Which?', []))).toBe(NO_ANSWER)
  })
})

describe('askedUserNotes', () => {
  it('lists only the notes the picks carry, in order', () => {
    const notes = askedUserNotes(question('Which?', [pick('A', { note: 'first' }), pick('B'), pick('C', { note: 'third' })], true))
    expect(notes).toEqual(['first', 'third'])
  })

  it('is empty when no pick has a note, and drops an empty note', () => {
    expect(askedUserNotes(question('Which?', [pick('A'), pick('B', { note: '' })]))).toEqual([])
  })
})

describe('askedUserHasRecommended', () => {
  it('is true when any chosen option was recommended', () => {
    expect(askedUserHasRecommended(question('Which?', [pick('A'), pick('B', { recommended: true })], true))).toBe(true)
  })

  it('is false when none was, and when nothing was answered', () => {
    expect(askedUserHasRecommended(question('Which?', [pick('A')]))).toBe(false)
    expect(askedUserHasRecommended(question('Which?', []))).toBe(false)
  })
})

describe('askedUserLabel', () => {
  it('names the card from its first question', () => {
    expect(askedUserLabel(model('answered', [question('Which database?'), question('Which cache?')]))).toBe(`${ASKED_USER_TITLE}: Which database?`)
  })

  it('uses the bare title without questions or with a blank first prompt', () => {
    expect(askedUserLabel(model('answered', []))).toBe(ASKED_USER_TITLE)
    expect(askedUserLabel(model('answered', [question(' ')]))).toBe(ASKED_USER_TITLE)
  })

  it('shortens a long first prompt so history cards stay one line', () => {
    const label = askedUserLabel(model('answered', [question('q'.repeat(200))]))
    expect(label).toBe(`${ASKED_USER_TITLE}: ${'q'.repeat(79)}...`)
  })
})
