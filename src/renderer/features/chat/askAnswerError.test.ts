import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({ notify }))

import { answerFailureText, REQUEST_GONE_MESSAGE } from './askAnswerError'

describe('answerFailureText (#1989)', () => {
  beforeEach(() => notify.mockClear())

  it('toasts a late answer and never shows the raw SessionAgent text', () => {
    const text = answerFailureText({ code: 'request-gone', message: 'SessionAgent s1: the question is no longer waiting for an answer' })

    expect(text).toBe(REQUEST_GONE_MESSAGE)
    expect(notify).toHaveBeenCalledWith({ code: 'request-gone', message: REQUEST_GONE_MESSAGE })
  })

  it('words an over-long typed answer plainly without a toast', () => {
    expect(answerFailureText({ code: 'invalid-argument', message: 'answer q1 customInput exceeds 4000 characters' })).toBe(
      'Your answer is too long. Shorten it and try again.'
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it('passes any other error message through untouched', () => {
    expect(answerFailureText({ code: 'prompt-failed', message: 'boom' })).toBe('boom')
    expect(notify).not.toHaveBeenCalled()
  })
})
