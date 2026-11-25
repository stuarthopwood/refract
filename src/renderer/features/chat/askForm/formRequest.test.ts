import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatAnswer, IpcError, Result } from '../../../../shared/ipc'
import type { AskFieldValue } from './answerPlan'
import {
  FORM_CANCEL,
  FORM_TIMED_OUT,
  SEND_FAILED_TEXT,
  answerKind,
  footerBusy,
  createFormResponder,
  firstInvalidField,
  formDeadlineText,
  formStatusNote,
  formSubmission,
  refusedPastDeadline,
  retryState,
  scheduleDeadline,
  sendFormAnswer,
  shouldClearErrorOnEdit,
  startingValues,
  visibleErrors,
  withTouched
} from './formRequest'
import { parseAskHtml, type AskFormField } from './parseAskHtml'

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

  test('Given a deadline beyond the timer limit, When the limit passes, Then it has not fired until the deadline does', () => {
    vi.setSystemTime(0)
    const fire = vi.fn()
    const deadlineAt = 2_147_483_647 * 2 + 1000
    scheduleDeadline(deadlineAt, 0, fire)
    vi.advanceTimersByTime(2_147_483_647)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_147_483_647)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  test('Given a far deadline was cleared after the first slice, When the deadline passes, Then nothing fires', () => {
    vi.setSystemTime(0)
    const fire = vi.fn()
    const clear = scheduleDeadline(2_147_483_647 + 1000, 0, fire)
    vi.advanceTimersByTime(2_147_483_647)
    clear()
    vi.advanceTimersByTime(10_000)
    expect(fire).not.toHaveBeenCalled()
  })

  test('Given a deadline already past, When scheduled, Then it fires on the next tick', () => {
    vi.setSystemTime(10_000)
    const fire = vi.fn()
    scheduleDeadline(5000, 10_000, fire)
    vi.advanceTimersByTime(0)
    expect(fire).toHaveBeenCalledTimes(1)
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

  test('Given a field was typed in but never left, When errors are read, Then none shows until it is touched', () => {
    const typed = withTouched(new Set(), 1)
    expect(visibleErrors(errors, new Set(), false)[0]).toBeNull()
    expect(visibleErrors(errors, typed, false)).toEqual([null, null, null])
    expect(visibleErrors(errors, withTouched(typed, 2), false)).toEqual([null, null, 'Too long'])
  })
})

describe('withTouched', () => {
  test('Given a field already touched, When touched again, Then the same set comes back', () => {
    const touched = withTouched(new Set(), 3)
    expect(withTouched(touched, 3)).toBe(touched)
    expect([...withTouched(touched, 1)].sort()).toEqual([1, 3])
  })
})

describe('answerKind and formStatusNote', () => {
  test.each([
    [{ data: { a: 'x' } }, 'submitted', 'Submitting your answers', 'Answers submitted'],
    [FORM_CANCEL, 'cancelled', 'Cancelling', 'Cancelled'],
    [FORM_TIMED_OUT, 'timedOut', 'Cancelling', 'Timed out, cancelled']
  ] as const)('Given %j was sent, Then it reads as %s and the notes follow what was sent', (answer, kind, sending, sent) => {
    expect(answerKind(answer)).toBe(kind)
    expect(formStatusNote('sending', kind)).toBe(sending)
    expect(formStatusNote('sent', kind)).toBe(sent)
    expect(formStatusNote('idle', kind)).toBeUndefined()
    expect(formStatusNote('locked', kind)).toBeUndefined()
  })

  test('Given nothing was sent, Then there is no note', () => {
    expect(formStatusNote('idle', null)).toBeUndefined()
    expect(formStatusNote('sent', null)).toBeUndefined()
  })
})

describe('footerBusy', () => {
  test.each([
    ['sending', 'submitted', { sending: true, cancelling: false }],
    ['sending', 'cancelled', { sending: false, cancelling: true }],
    ['sending', 'timedOut', { sending: false, cancelling: true }],
    ['idle', 'submitted', { sending: false, cancelling: false }],
    ['sent', 'cancelled', { sending: false, cancelling: false }]
  ] as const)('Given phase %s after a %s answer, Then the busy buttons are %j', (phase, kind, expected) => {
    expect(footerBusy(phase, kind)).toEqual(expected)
  })

  test('Given nothing was sent, Then neither button is busy', () => {
    expect(footerBusy('sending', null)).toEqual({ sending: false, cancelling: false })
  })
})

describe('retryState', () => {
  test('Given a locked timed-out cancel, Then Retry shows and stays, busy, while its resend is in flight', () => {
    expect(retryState('locked', 'timedOut')).toEqual({ visible: true, busy: false })
    expect(retryState('sending', 'timedOut')).toEqual({ visible: true, busy: true })
  })

  test('Given any other phase or answer, Then there is no Retry', () => {
    expect(retryState('sending', 'submitted')).toEqual({ visible: false, busy: true })
    expect(retryState('sent', 'timedOut')).toEqual({ visible: false, busy: false })
    expect(retryState('idle', null)).toEqual({ visible: false, busy: false })
  })
})

describe('shouldClearErrorOnEdit', () => {
  test.each([
    ['a refused send', 'idle', 'refused', true],
    ['no error', 'idle', null, false],
    ['a send in flight', 'sending', 'refused', false],
    ['a locked form', 'locked', 'refused', false],
    ['a sent form', 'sent', 'refused', false]
  ] as const)('Given %s, When the user edits, Then the error clear is %s', (_name, phase, error, expected) => {
    expect(shouldClearErrorOnEdit(phase, error)).toBe(expected)
  })
})

describe('refusedPastDeadline', () => {
  const deadline = 1_000

  test('Given a refusal that lands at or after the deadline, Then the form is timed out rather than re-opened', () => {
    expect(refusedPastDeadline('idle', 'refused', deadline, deadline)).toBe(true)
    expect(refusedPastDeadline('idle', 'refused', deadline, deadline + 1)).toBe(true)
  })

  test.each([
    ['before the deadline', 'idle', 'refused', deadline, deadline - 1],
    ['with no deadline', 'idle', 'refused', undefined, deadline],
    ['without an error', 'idle', null, deadline, deadline + 1],
    ['while sending', 'sending', 'refused', deadline, deadline + 1],
    ['once locked', 'locked', 'refused', deadline, deadline + 1]
  ] as const)('Given a refusal %s, Then the form is not timed out again', (_name, phase, error, at, now) => {
    expect(refusedPastDeadline(phase, error, at, now)).toBe(false)
  })

  test('Given a refused submit past the deadline, When the timed-out cancel is refused too, Then the form locks', async () => {
    const refused: Result<void> = { ok: false, error: { code: 'request-gone', message: 'gone' } }
    const outcome = await sendFormAnswer(FORM_TIMED_OUT, async () => refused, () => 'refused')
    expect(outcome.phase).toBe('locked')
  })
})

describe('sendFormAnswer', () => {
  const refusedError: IpcError = { code: 'request-gone', message: 'gone' }
  const refused: Result<void> = { ok: false, error: refusedError }
  const failureText = (error: IpcError): string => `refused: ${error.message}`

  test('Given OMP took the answer, Then the phase is sent with no error', async () => {
    expect(await sendFormAnswer({ data: {} }, async () => ({ ok: true, value: undefined }), failureText)).toEqual({ accepted: true, phase: 'sent', error: null })
  })

  test('Given OMP refused a submit or a cancel, Then the form re-opens with the error', async () => {
    expect(await sendFormAnswer({ data: {} }, async () => refused, failureText)).toEqual({ accepted: false, phase: 'idle', error: 'refused: gone' })
    expect(await sendFormAnswer(FORM_CANCEL, async () => refused, failureText)).toEqual({ accepted: false, phase: 'idle', error: 'refused: gone' })
  })

  test('Given OMP refused the timed-out cancel, Then the form stays locked with the error', async () => {
    expect(await sendFormAnswer(FORM_TIMED_OUT, async () => refused, failureText)).toEqual({ accepted: false, phase: 'locked', error: 'refused: gone' })
  })

  test('Given a refusal, Then the failure text is told which answer was sent so a cancel can be worded as one (#2135)', async () => {
    const failureFor = vi.fn((_error: IpcError, _answer: ChatAnswer) => 'refused')
    await sendFormAnswer(FORM_CANCEL, async () => refused, failureFor)
    await sendFormAnswer(FORM_TIMED_OUT, async () => refused, failureFor)
    expect(failureFor.mock.calls.map(([, answer]) => answer)).toEqual([FORM_CANCEL, FORM_TIMED_OUT])
  })

  test('Given the call rejects, Then it reads as a refusal instead of leaving the form sending', async () => {
    const reject = async (): Promise<Result<void>> => {
      throw new Error('ipc down')
    }
    expect(await sendFormAnswer({ data: {} }, reject, failureText)).toEqual({ accepted: false, phase: 'idle', error: SEND_FAILED_TEXT })
    expect(await sendFormAnswer(FORM_TIMED_OUT, reject, failureText)).toEqual({ accepted: false, phase: 'locked', error: SEND_FAILED_TEXT })
  })

  test('Given a refused timed-out cancel, When Retry resends it through the responder, Then it is sent again until accepted', async () => {
    const call = vi.fn<() => Promise<Result<void>>>().mockResolvedValueOnce(refused).mockResolvedValueOnce({ ok: true, value: undefined })
    const phases: string[] = []
    const responder = createFormResponder(async (answer) => {
      const outcome = await sendFormAnswer(answer, call, failureText)
      phases.push(outcome.phase)
      return outcome.accepted
    })
    expect(await responder.respond(FORM_TIMED_OUT)).toBe(false)
    expect(await responder.respond(FORM_TIMED_OUT)).toBe(true)
    expect(await responder.respond(FORM_TIMED_OUT)).toBe(false)
    expect(phases).toEqual(['locked', 'sent'])
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('firstInvalidField', () => {
  test('Given errors, Then the first invalid index is returned, or -1 when none', () => {
    expect(firstInvalidField([null, 'x', 'y'])).toBe(1)
    expect(firstInvalidField([null, null])).toBe(-1)
  })
})

const fieldsOf = (html: string): AskFormField[] => parseAskHtml(html) as AskFormField[]
const textValue = (value: string): AskFieldValue => ({ kind: 'text', text: value })
const range = (attrs: string): AskFormField[] => fieldsOf(`<input type="range" name="a" aria-label="A" ${attrs}>`)

describe('startingValues', () => {
  test.each([
    ['min 0, max 5, step 1', 'min="0" max="5" step="1"', '3'],
    ['no bounds', '', '50'],
    ['a negative min', 'min="-5" max="0" step="1"', '-2'],
    ['a step coarser than the midpoint', 'min="0" max="5" step="10"', '0'],
    ['a step from a non-zero min, halfway between two steps', 'min="1" max="10" step="3"', '7'],
    ['a fractional step', 'min="0" max="1" step="0.1"', '0.5']
  ])('Given an untouched range with %s, When values start, Then it holds the snapped midpoint %s', (_label, attrs, expected) => {
    expect(startingValues(range(attrs))).toEqual([textValue(expected)])
  })

  test('Given a range with a default, When values start, Then the default is kept', () => {
    expect(startingValues(range('min="0" max="10" value="7"'))).toEqual([textValue('7')])
  })

  test('Given text and choice defaults, When values start, Then they are honoured', () => {
    const fields = fieldsOf('<input name="t" aria-label="T" value="hi"><label><input type="radio" name="r" value="x" checked> X</label><label><input type="radio" name="r" value="y"> Y</label>')
    expect(startingValues(fields)).toEqual([textValue('hi'), { kind: 'choice', selected: ['x'], otherSelected: false, otherText: '' }])
  })
})

describe('formSubmission', () => {
  const fields = fieldsOf('<input name="a" aria-label="A" required><input type="number" name="n" aria-label="N" max="5">')

  test('Given every field valid, When submitted, Then the answer carries the data', () => {
    expect(formSubmission(fields, [textValue('x'), textValue('4')])).toEqual({ errors: [null, null], answer: { data: { a: 'x', n: 4 } } })
  })

  test('Given any field invalid, When submitted, Then there is no answer and the errors say which', () => {
    const result = formSubmission(fields, [textValue('x'), textValue('9')])
    expect(result.answer).toBeNull()
    expect(result.errors).toEqual([null, 'Must be at most 5'])
  })
})

describe('formDeadlineText', () => {
  test('Given a deadline, Then the line names a time and says the form is cancelled', () => {
    expect(formDeadlineText(new Date(2026, 10, 25, 14, 5).getTime())).toMatch(/^If there's no answer by .*\d.*, the form is cancelled\.$/)
  })
})
