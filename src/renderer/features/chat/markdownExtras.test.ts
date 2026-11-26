// The repo has no jsdom: the table is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { MarkdownOptionsContext, MarkdownTable, type MarkdownOptions } from './markdownExtras'

function table(options: Partial<MarkdownOptions>) {
  return renderToStaticMarkup(
    createElement(MarkdownOptionsContext.Provider, { value: { githubStyle: false, ...options } }, createElement(MarkdownTable, null, createElement('tbody')))
  )
}

describe('MarkdownTable scroll region (#2033)', () => {
  it.each([
    ['the chat style', false],
    ['the GitHub style', true]
  ])('is a named, keyboard-focusable region in %s so a wide table can be scrolled without a pointer', (_name, githubStyle) => {
    const wrapper = table({ githubStyle }).match(/^<div[^>]*>/)?.[0] ?? ''
    expect(wrapper).toContain('tabindex="0"')
    expect(wrapper).toContain('role="region"')
    expect(wrapper).toContain('aria-label="Scrollable table"')
    expect(wrapper).toContain('overflow-x-auto')
  })

  it('shows a focus outline on the region that forced-colors mode keeps, not a box-shadow ring it drops', () => {
    const wrapper = table({}).match(/^<div[^>]*>/)?.[0] ?? ''
    expect(wrapper).toContain(INSET_FOCUS_OUTLINE_CLASS)
    expect(wrapper).not.toContain('focus-visible:ring')
  })

  it('is not focusable, named or a region when inert, because it sits inside an interactive control', () => {
    const wrapper = table({ inert: true }).match(/^<div[^>]*>/)?.[0] ?? ''
    expect(wrapper).not.toContain('tabindex')
    expect(wrapper).not.toContain('role=')
    expect(wrapper).not.toContain('aria-label')
  })
})
