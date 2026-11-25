import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatAnswer } from '../../../../shared/ipc'
import { FORM_CANCEL, FORM_TIMED_OUT, createFormResponder, firstInvalidField, scheduleDeadline, visibleErrors } from './formRequest'
import { parseAskHtml } from './parseAskHtml'

describe('createFormResponder', () => {
  test('Given a submit and a deadline firing together, When both respond, Then OMP receives one answer', async () => {
    const send = vi.fn(async (_answer: ChatAnswer) => true)
    const responder = createFormResponder(send)
    const results = await Promise.all([responder.respond({ data: { a: '1' } }), responder.respond(FORM_TIMED_OUT)])
    expect(results).toEqual([true, false])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ data: { a: '1' } })
  })

  test('Given an answer was accepted, When Cancel is pressed later, Then nothing more is sent', async () => {
    const send = vi.fn(async (_answer: ChatAnswer) => true)
    const responder = createFormResponder(send)
    await responder.respond({ data: {} })
    expect(await responder.respond(FORM_CANCEL)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('Given OMP refused the send, When the user retries, Then the retry is sent', async () => {
    const send = vi.fn<(answer: ChatAnswer) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const responder = createFormResponder(send)
    expect(await responder.respond({ data: {} })).toBe(false)
    expect(await responder.respond({ data: {} })).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('Given unparseable html, When the card opens, Then one plain cancel is sent however often it re-runs', async () => {
    expect(parseAskHtml('')).toBeNull()
    const send = vi.fn(async (_answer: ChatAnswer) => true)
    const responder = createFormResponder(send)
    await responder.respond(FORM_CANCEL)
    await responder.respond(FORM_CANCEL)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ cancelled: true })
  })
})

describe('scheduleDeadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('Given a deadline in the future, When it passes, Then the callback fires once', () => {
    const fire = vi.fn()
    scheduleDeadline(5000, 0, fire)
    vi.advanceTimersByTime(4999)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  test('Given the timer was cleared on unmount, When the deadline passes, Then nothing fires', () => {
    const fire = vi.fn()
    const clear = scheduleDeadline(5000, 0, fire)
    clear()
    vi.advanceTimersByTime(10_000)
    expect(fire).not.toHaveBeenCalled()
  })

  test('Given no deadline, When time passes, Then nothing fires', () => {
    const fire = vi.fn()
    scheduleDeadline(undefined, 0, fire)
    vi.advanceTimersByTime(10_000_000)
    expect(fire).not.toHaveBeenCalled()
  })
})

describe('visibleErrors', () => {
  const errors = ['Required', null, 'Too long']

  test('Given nothing touched and no attempt, Then no message shows', () => {
    expect(visibleErrors(errors, new Set(), false)).toEqual([null, null, null])
  })

  test('Given one field touched, Then only its message shows', () => {
    expect(visibleErrors(errors, new Set([2]), false)).toEqual([null, null, 'Too long'])
  })

  test('Given Submit was attempted, Then every message shows', () => {
    expect(visibleErrors(errors, new Set(), true)).toEqual(errors)
  })
})

describe('firstInvalidField', () => {
  test('Given errors, Then the first invalid index is returned, or -1 when none', () => {
    expect(firstInvalidField([null, 'x', 'y'])).toBe(1)
    expect(firstInvalidField([null, null])).toBe(-1)
  })
})
