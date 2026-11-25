// The repo has no DOM, so the footer renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AskFormFooter } from './AskFormFooter'

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

  test('Given an error with a retry, Then the alert carries a Retry button that is operable when idle', () => {
    const html = render({ error: 'refused', retry: { busy: false, onRetry: () => undefined } })
    expect(html).toContain('Retry')
    expect(html).not.toContain('aria-busy="true"')
  })

  test('Given a retry send in flight, Then Retry stays mounted, busy and aria-disabled', () => {
    const html = render({ error: 'refused', retry: { busy: true, onRetry: () => undefined } })
    const retry = html.match(/<button[^>]*>(?:(?!<\/button>).)*Retry/)?.[0] ?? ''
    expect(retry).toContain('aria-disabled="true"')
    expect(retry).toContain('aria-busy="true"')
  })

  test('Given a deadline line and a note, Then both show, the note in a status region', () => {
    const html = render({ deadlineText: "If there's no answer by 14:05, the form is cancelled.", note: 'Answers submitted' })
    expect(html).toContain('the form is cancelled.')
    expect(html).toMatch(/role="status"[^>]*>Answers submitted</)
  })

  test('Given no note, Then the status region stays mounted but screen-reader only', () => {
    const statusTag = (html: string) => html.match(/<[a-z]+[^>]*role="status"[^>]*>/)?.[0] ?? ''
    expect(statusTag(render())).toContain('sr-only')
    expect(statusTag(render({ note: 'Cancelled' }))).not.toContain('sr-only')
  })

  test('Given a send in flight, Then Submit reads Submitting and is busy, and a locked form is not operable', () => {
    const sending = render({ sending: true, cancellable: false, submittable: false })
    expect(sending).toContain('Submitting…')
    expect(sending).toContain('aria-busy="true"')
    expect(sending.match(/aria-disabled="true"/g)).toHaveLength(2)
  })

  test('Given a cancel in flight, Then Cancel is busy and Submit is not', () => {
    const html = render({ cancelling: true, cancellable: false, submittable: false })
    expect(html).toContain('Cancelling…')
    expect(html).not.toContain('Submitting')
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1)
  })

  test('Given custom labels, Then they replace Cancel and Submit at rest, and the busy wording wins while a send runs', () => {
    const resting = render({ cancelLabel: 'Skip', submitLabel: 'Next' })
    expect(resting).toContain('Skip')
    expect(resting).toContain('Next')
    expect(resting).not.toContain('Cancel<')
    expect(resting).not.toContain('Submit<')
    expect(render({ submitLabel: 'Next', sending: true })).toContain('Submitting…')
  })

  test('Given an actions slot, Then it sits between Cancel and Submit', () => {
    const html = render({ actions: createElement('button', null, 'Use Recommended') })
    expect(html.indexOf('Cancel')).toBeLessThan(html.indexOf('Use Recommended'))
    expect(html.indexOf('Use Recommended')).toBeLessThan(html.indexOf('Submit'))
  })
})
