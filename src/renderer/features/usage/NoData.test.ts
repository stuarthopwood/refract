// The repo has no jsdom, so the markup is rendered to a string. Named `.ts` because vitest only includes `*.test.ts`.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NoData } from './NoData'

describe('NoData', () => {
  it('hides the dash from assistive tech and exposes the default label as text and title', () => {
    const html = renderToStaticMarkup(createElement(NoData))
    expect(html).toContain('<span aria-hidden="true">-</span>')
    expect(html).toContain('<span class="sr-only">No data</span>')
    expect(html).toContain('title="No data"')
  })

  it('exposes a custom label as text and title', () => {
    const html = renderToStaticMarkup(createElement(NoData, { label: 'No priced calls' }))
    expect(html).toContain('<span class="sr-only">No priced calls</span>')
    expect(html).toContain('title="No priced calls"')
  })
})
