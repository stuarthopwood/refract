// The repo has no DOM, so the footer renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AskFormFooter, sessionPhaseNote } from './AskFormChrome'

type FooterProps = Parameters<typeof AskFormFooter>[0]

const base: FooterProps = { error: null, note: undefined, cancellable: true, submittable: true, sending: false, onCancel: () => undefined, onSubmit: () => undefined }
const render = (props: Partial<FooterProps> = {}): string => renderToStaticMarkup(createElement(AskFormFooter, { ...base, ...props }))

describe('AskFormFooter', () => {
  test('Given an idle form, Then Cancel and Submit are operable and nothing else shows', () => {
    const html = render()
    expect(html).toContain('Cancel')
    expect(html).toContain('Submit')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('Retry')
    expect(html).not.toContain('aria-busy="true"')
  })

  test('Given an error without a retry, Then the alert shows and there is no Retry', () => {
    const html = render({ error: 'That question was already closed' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('That question was already closed')
    expect(html).not.toContain('Retry')
  })

  test('Given an error with a retry, Then the alert carries a Retry button', () => {
    const html = render({ error: 'refused', onRetry: () => undefined })
    expect(html).toContain('Retry')
  })

  test('Given a deadline line and a note, Then both show, the note in a status region', () => {
    const html = render({ deadlineText: "If there's no answer by 14:05, the form is cancelled.", note: 'Answers submitted' })
    expect(html).toContain('the form is cancelled.')
    expect(html).toMatch(/role="status"[^>]*>Answers submitted</)
  })

  test('Given a send in flight, Then Submit reads Submitting and is busy, and a locked form is not operable', () => {
    const sending = render({ sending: true, cancellable: false, submittable: false })
    expect(sending).toContain('Submitting...')
    expect(sending).toContain('aria-busy="true"')
    expect(sending.match(/aria-disabled="true"/g)).toHaveLength(2)
  })
})

describe('sessionPhaseNote', () => {
  test('Given each per-field session phase, Then the note keeps its wording', () => {
    expect(sessionPhaseNote('answering')).toBe('Submitting your answers')
    expect(sessionPhaseNote('cancelling')).toBe('Cancelled')
    expect(sessionPhaseNote('done')).toBe('Answers submitted')
    expect(sessionPhaseNote('editing')).toBeUndefined()
  })
})
