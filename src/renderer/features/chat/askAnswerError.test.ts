import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notifyInfo = vi.hoisted(() => vi.fn())
// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({ notifyInfo }))

import { answerFailureFor, answerFailureText, REQUEST_GONE_CANCEL_MESSAGE, REQUEST_GONE_MESSAGE, sendAnswer } from './askAnswerError'

const gone = { code: 'request-gone', message: 'SessionAgent s1: the question is no longer waiting for an answer' } as const

describe('answerFailureText (#1989, #2135)', () => {
  beforeEach(() => notifyInfo.mockClear())

  it('raises an info notice for a late answer and never shows the raw SessionAgent text', () => {
    const text = answerFailureText(gone)

    expect(text).toBe(REQUEST_GONE_MESSAGE)
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_MESSAGE)
  })

  it('words a late cancel as nothing to cancel, not as an unsent answer', () => {
    const text = answerFailureText(gone, 'cancel')

    expect(text).toBe(REQUEST_GONE_CANCEL_MESSAGE)
    expect(text).not.toContain('answer')
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_CANCEL_MESSAGE)
  })

  it('words an over-long typed answer plainly without a toast', () => {
    expect(answerFailureText({ code: 'invalid-argument', message: 'answer q1 customInput exceeds 4000 characters' })).toBe(
      'Your answer is too long. Shorten it and try again.'
    )
    expect(notifyInfo).not.toHaveBeenCalled()
  })

  it('passes any other error message through untouched', () => {
    expect(answerFailureText({ code: 'prompt-failed', message: 'boom' })).toBe('boom')
    expect(notifyInfo).not.toHaveBeenCalled()
  })
})

describe('answerFailureFor (#2135)', () => {
  beforeEach(() => notifyInfo.mockClear())

  it.each([
    ['a cancel', { cancelled: true }],
    ['a deadline cancel', { cancelled: true, timedOut: true }]
  ] as const)('words a late %s as nothing to cancel', (_name, answer) => {
    expect(answerFailureFor(gone, answer)).toBe(REQUEST_GONE_CANCEL_MESSAGE)
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_CANCEL_MESSAGE)
  })

  it.each([
    ['an approval or confirm', { confirmed: false }],
    ['a typed or picked value', { value: 'x' }],
    ['a form submission', { data: {} }]
  ] as const)('keeps the unsent-answer wording for %s', (_name, answer) => {
    expect(answerFailureFor(gone, answer)).toBe(REQUEST_GONE_MESSAGE)
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_MESSAGE)
  })
})

describe('sendAnswer (#2135)', () => {
  const answer = vi.fn()
  beforeEach(() => {
    notifyInfo.mockClear()
    answer.mockReset()
    vi.stubGlobal('window', { refract: { chat: { answer } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the cancel wording when an ask card Cancel lands on a closed question', async () => {
    answer.mockResolvedValue({ ok: false, error: gone })

    expect(await sendAnswer('s1', 'r1', { cancelled: true })).toBe(REQUEST_GONE_CANCEL_MESSAGE)
    expect(answer).toHaveBeenCalledWith('s1', 'r1', { cancelled: true })
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_CANCEL_MESSAGE)
  })

  it('shows the unsent-answer wording when a submission lands on a closed question', async () => {
    answer.mockResolvedValue({ ok: false, error: gone })

    expect(await sendAnswer('s1', 'r1', { value: 'x' })).toBe(REQUEST_GONE_MESSAGE)
  })

  it('resolves null when OMP took the answer', async () => {
    answer.mockResolvedValue({ ok: true, value: undefined })

    expect(await sendAnswer('s1', 'r1', { cancelled: true })).toBeNull()
    expect(notifyInfo).not.toHaveBeenCalled()
  })
})
