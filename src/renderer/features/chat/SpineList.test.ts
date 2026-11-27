// The repo has no jsdom: the list is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SpineItem, SpineList } from './SpineList'

function listTokens(bare: boolean): string[] {
  const row = createElement(SpineItem, { isNew: false, children: 'row' })
  const html = renderToStaticMarkup(createElement(SpineList, { bare, children: row }))
  return html.match(/<ol[^>]*class="([^"]*)"/)![1]!.split(' ')
}

describe('SpineList', () => {
  it('draws the guide rail by default', () => {
    const tokens = listTokens(false)
    expect(tokens).toContain('border-l')
    expect(tokens).toContain('ml-4')
  })

  it('drops the rail when bare, since nesting is shown by fill', () => {
    const tokens = listTokens(true)
    expect(tokens).not.toContain('border-l')
    expect(tokens).not.toContain('ml-4')
  })

  it('keeps a rail in forced colours when bare, where the fill that shows nesting is dropped', () => {
    expect(listTokens(true)).toContain('forced-colors:border-l')
  })
})
