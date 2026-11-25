// The repo has no jsdom, so the view renders to a string and the send/retry flow runs through the real responder.
// The hook pulls in the renderer stores, which need a window; only its type is used here.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { ChatAnswer } from '../../../../shared/ipc'
import { createFormResponder, type FormSendPhase } from './formRequest'
import { UNSHOWN_FORM_NOTICE, UnshownFormView, cancelUnshownForm, unshownFormNoticeState, unshownFormNoticeText } from './UnshownFormNotice'

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

  test('Given the cancel is in flight, When the notice renders, Then it says it is being cancelled and has no Retry', () => {
    const html = render('sending', null)
    expect(html).not.toContain('Retry')
    expect(html).toContain('so it is being cancelled.')
  })

  test('Given a retry in flight, When the notice renders, Then Retry stays mounted, busy and aria-disabled', () => {
    const retry = render('sending', 'refused').match(/<button[^>]*>(?:(?!<\/button>).)*Retry/)?.[0] ?? ''
    expect(retry).toContain('aria-busy="true"')
    expect(retry).toContain('aria-disabled="true"')
  })

  test('Given the notice, Then it sits in a programmatically focusable wrapper that Retry can hand focus to', () => {
    expect(render('sent', null)).toMatch(/^<div[^>]*tabindex="-1"/)
  })
})

describe('unshownFormNoticeState', () => {
  test('Given each send phase, When the state is read, Then Retry shows when refused and stays through its resend', () => {
    expect(unshownFormNoticeState('idle', 'refused')).toEqual({ error: 'refused', canRetry: true, retrying: false, outcome: 'refused' })
    expect(unshownFormNoticeState('idle', null)).toEqual({ error: null, canRetry: false, retrying: false, outcome: 'cancelling' })
    expect(unshownFormNoticeState('sending', 'refused')).toEqual({ error: null, canRetry: true, retrying: true, outcome: 'cancelling' })
    expect(unshownFormNoticeState('sending', null)).toEqual({ error: null, canRetry: false, retrying: false, outcome: 'cancelling' })
    expect(unshownFormNoticeState('sent', null)).toEqual({ error: null, canRetry: false, retrying: false, outcome: 'cancelled' })
  })

  test('Given each outcome, When the wording is read, Then it says being cancelled, cancelled or could not be cancelled, keeping "form"', () => {
    expect(unshownFormNoticeText('cancelling')).toContain('is being cancelled')
    expect(unshownFormNoticeText('cancelled')).toBe(UNSHOWN_FORM_NOTICE)
    expect(unshownFormNoticeText('refused')).toContain("couldn't be cancelled")
    for (const outcome of ['cancelling', 'cancelled', 'refused'] as const) expect(unshownFormNoticeText(outcome)).toContain('"form"')
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
