// The repo has no jsdom, so the markup is rendered to a string. Named `.ts` because vitest only includes `*.test.ts`.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageFilters } from './UsageFilters'

const markup = () => renderToStaticMarkup(createElement(UsageFilters))

describe('UsageFilters date range tabs', () => {
  it('offers every range in order, with the new 14 days, MTD and YTD between the existing ones', () => {
    const html = markup()
    const labels = ['Today', '7 days', '14 days', '30 days', 'MTD', 'YTD', 'All', 'Custom']
    const positions = labels.map((label) => html.indexOf(`>${label}</button>`))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('selects the default 7 days range', () => {
    const html = markup()
    expect(html).toMatch(/aria-selected="true"[^>]*data-state="active"[^>]*>7 days</)
  })

  it('keeps the tabs on one scrolling row instead of wrapping them', () => {
    const html = markup()
    expect(html).toContain('overflow-x-auto')
    expect(html).toMatch(/role="tablist"[^>]*class="[^"]*\bw-max\b[^"]*"[^>]*aria-label="Date range"/)
  })
})
