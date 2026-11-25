// The repo has no DOM: the hook is rendered once to a string so its responder can be driven directly.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { REQUEST_GONE_CANCEL_MESSAGE, REQUEST_GONE_MESSAGE } from '../askAnswerError'
import { FORM_CANCEL, FORM_TIMED_OUT, type FormResponder } from './formRequest'
import { useFormResponder } from './useFormResponder'

const notifyInfo = vi.hoisted(() => vi.fn())
// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({ notifyInfo }))

const gone = { ok: false, error: { code: 'request-gone', message: 'SessionAgent s1: the question is no longer waiting for an answer' } }

function responderFor(): FormResponder {
  let captured: FormResponder | undefined
  const Probe = () => {
    captured = useFormResponder('s1', 'r1').responder
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  if (!captured) throw new Error('the hook did not render')
  return captured
}

describe('useFormResponder late sends (#2135)', () => {
  const answer = vi.fn()
  beforeEach(() => {
    notifyInfo.mockClear()
    answer.mockReset().mockResolvedValue(gone)
    vi.stubGlobal('window', { refract: { chat: { answer } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  test.each([
    ['Cancel', FORM_CANCEL],
    ['the deadline', FORM_TIMED_OUT]
  ])('Given %s lands on a closed form, When OMP refuses it, Then it is worded as a cancel', async (_name, cancel) => {
    expect(await responderFor().respond(cancel)).toBe(false)
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_CANCEL_MESSAGE)
  })

  test('Given a submit lands on a closed form, When OMP refuses it, Then it keeps the unsent-answer wording', async () => {
    expect(await responderFor().respond({ data: { a: '1' } })).toBe(false)
    expect(notifyInfo).toHaveBeenCalledWith(REQUEST_GONE_MESSAGE)
  })
})
