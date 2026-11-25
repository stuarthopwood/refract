// The repo has no jsdom, so the view renders to a string and the send/retry flow runs through the real responder.
// The hook pulls in the renderer stores, which need a window; only its type is used here.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { ChatAnswer } from '../../../../shared/ipc'
import { createFormResponder, type FormSendPhase } from './formRequest'
import { UNSHOWN_FORM_NOTICE, UnshownFormView, cancelUnshownForm, unshownFormNoticeState } from './UnshownFormNotice'

vi.mock('./useFormResponder', () => ({ useFormResponder: () => undefined }))

const render = (phase: FormSendPhase, error: string | null): string => renderToStaticMarkup(createElement(UnshownFormView, { phase, error, onRetry: () => undefined }))

describe('UnshownFormView', () => {
  test('Given a form that cannot be shown, When the notice renders, Then it names the "form" dialog and has no Retry', () => {
    const html = render('sent', null)
    expect(UNSHOWN_FORM_NOTICE).toContain('"form"')
    expect(html).toContain(UNSHOWN_FORM_NOTICE.replace(/"/g, '&quot;').replace(/'/g, '&#x27;'))
    expect(html).not.toContain('Retry')
    expect(html).toContain('role="status"')
  })

  test('Given a refused cancel, When the notice renders, Then it shows the error and a Retry button', () => {
    const html = render('idle', 'OMP no longer has that question')
    expect(html).toContain('OMP no longer has that question')
    expect(html).toContain('Retry')
    expect(html).toContain('role="alert"')
  })

  test('Given the cancel has not been refused, When the notice renders, Then there is no Retry before or during the send', () => {
    expect(render('idle', null)).not.toContain('Retry')
    expect(render('sending', null)).not.toContain('Retry')
  })
})

describe('unshownFormNoticeState', () => {
  test('Given each send phase, When the state is read, Then only an idle phase with an error offers Retry', () => {
    expect(unshownFormNoticeState('idle', 'refused')).toEqual({ error: 'refused', canRetry: true })
    expect(unshownFormNoticeState('idle', null)).toEqual({ error: null, canRetry: false })
    expect(unshownFormNoticeState('sending', 'stale')).toEqual({ error: null, canRetry: false })
    expect(unshownFormNoticeState('sent', null)).toEqual({ error: null, canRetry: false })
  })
})

describe('cancelUnshownForm', () => {
  test('Given the cancel is opened twice, When both run, Then one plain cancel reaches OMP', async () => {
    const send = vi.fn(async (_answer: ChatAnswer) => true)
    const responder = createFormResponder(send)
    await cancelUnshownForm(responder)
    await cancelUnshownForm(responder)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ cancelled: true })
  })

  test('Given OMP refused the cancel, When the user retries, Then exactly one more cancel is sent', async () => {
    const send = vi.fn<(answer: ChatAnswer) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const responder = createFormResponder(send)
    expect(await cancelUnshownForm(responder)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await cancelUnshownForm(responder)).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith({ cancelled: true })
    await cancelUnshownForm(responder)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
