import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HandoffNoteLine } from './HandoffNoteLine'

describe('HandoffNoteLine', () => {
  it('renders the exact label inside a SourceTag carrying the given id', () => {
    const html = renderToStaticMarkup(createElement(HandoffNoteLine, { id: 'line-1' }))
    expect(html).toContain('Handoff note from the previous Conversation')
    expect(html).toContain('data-slot="source-tag"')
    expect(html).toContain('id="line-1"')
  })
})
