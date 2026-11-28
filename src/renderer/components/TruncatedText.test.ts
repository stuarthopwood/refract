// The repo has no jsdom: the component is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { shouldOpenTooltip, TruncatedText } from './TruncatedText'

describe('TruncatedText', () => {
  it('keeps the whole text in the DOM and cuts it off visually', () => {
    const text = createElement(TruncatedText, { tooltip: 'full path', className: 'flex-1', children: 'C:/Repos/very/long/path' })
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, text))
    expect(html).toContain('C:/Repos/very/long/path')
    expect(html).toMatch(/class="[^"]*\bblock\b[^"]*\bmin-w-0\b[^"]*\btruncate\b/)
    expect(html).toContain('flex-1')
  })

  it('starts with the tooltip closed and adds no native title', () => {
    const text = createElement(TruncatedText, { tooltip: 'full path', children: 'short' })
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, text))
    expect(html).not.toContain('title=')
    expect(html).not.toContain('full path')
  })
})

describe('shouldOpenTooltip', () => {
  it('stays closed when the text exactly fits', () => {
    expect(shouldOpenTooltip(true, { scrollWidth: 120, clientWidth: 120 })).toBe(false)
  })

  it('opens when the text is one pixel wider than its box', () => {
    expect(shouldOpenTooltip(true, { scrollWidth: 121, clientWidth: 120 })).toBe(true)
  })

  it('stays closed when the element is gone', () => {
    expect(shouldOpenTooltip(true, null)).toBe(false)
  })

  it('stays closed when not asked to open, even if the text is cut off', () => {
    expect(shouldOpenTooltip(false, { scrollWidth: 300, clientWidth: 120 })).toBe(false)
  })
})
