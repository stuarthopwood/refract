import { beforeEach, describe, expect, it, vi } from 'vitest'

const notifyInfo = vi.hoisted(() => vi.fn())
// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({ notifyInfo }))

import { answerFailureText, REQUEST_GONE_CANCEL_MESSAGE, REQUEST_GONE_MESSAGE } from './askAnswerError'

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
