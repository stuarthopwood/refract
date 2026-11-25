// The repo has no DOM, so the shell renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AskFormShell } from './AskFormShell'

const render = (props: Omit<Parameters<typeof AskFormShell>[0], 'children'>): string => renderToStaticMarkup(createElement(AskFormShell, { ...props, children: createElement('p', null, 'body') }))

describe('AskFormShell', () => {
  test('Given a label and a title, Then the card is a named group with its heading', () => {
    const html = render({ label: 'Asked: pick', title: 'Questions from the agent' })
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Asked: pick"')
    expect(html).toContain('Questions from the agent')
    expect(html).toContain('body')
  })

  test('Given neither label nor title, Then the card is a plain box with no group role or header', () => {
    const html = render({})
    expect(html).not.toContain('role="group"')
    expect(html).not.toContain('aria-label')
    expect(html).not.toContain('data-slot="card-header"')
    expect(html).toContain('body')
  })
})
