// The repo has no DOM, so the button renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { RetryButton } from './RetryButton'

const render = (busy: boolean): string => renderToStaticMarkup(createElement(RetryButton, { busy, onRetry: () => undefined, handoffTo: { current: null } }))

describe('RetryButton', () => {
  test('Given a send in flight, Then Retry stays mounted, busy and aria-disabled', () => {
    const html = render(true)
    expect(html).toContain('Retry')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-disabled="true"')
  })

  test('Given no send in flight, Then Retry is neither busy nor aria-disabled', () => {
    const html = render(false)
    expect(html).toContain('Retry')
    expect(html).not.toContain('aria-busy="true"')
    expect(html).not.toContain('aria-disabled="true"')
  })
})
