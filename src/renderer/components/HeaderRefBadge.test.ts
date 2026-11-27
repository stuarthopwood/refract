// The repo has no DOM, so the badge renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HeaderRefBadge, headerRefBadgeName, headerRefBadgeTooltip } from './HeaderRefBadge'

const render = (props: { text: string; status?: string; extra?: number; action: string }): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(HeaderRefBadge, { icon: null, ...props })))

describe('headerRefBadgeName', () => {
  test('Given a lone open item, Then the name is the reference, state and action', () => {
    expect(headerRefBadgeName({ text: '#1738', status: 'open', action: 'open pull request' })).toBe('#1738, open: open pull request')
  })

  test('Given more items behind the badge, Then the name speaks the overflow count before the action', () => {
    expect(headerRefBadgeName({ text: '#1738', status: 'open', extra: 1, action: 'show pull requests and issues' })).toBe(
      '#1738, open, and 1 more: show pull requests and issues'
    )
  })

  test('Given no state, Then the name skips it', () => {
    expect(headerRefBadgeName({ text: '#4', action: 'open issue' })).toBe('#4: open issue')
  })
})

describe('headerRefBadgeTooltip', () => {
  test('Given an item title and state, Then the tooltip names the action, title and state', () => {
    expect(headerRefBadgeTooltip({ action: 'open issue', itemTitle: 'Fix header', status: 'open' })).toBe('Open issue: Fix header (open)')
  })

  test('Given no title or state, Then the tooltip is only the capitalised action', () => {
    expect(headerRefBadgeTooltip({ action: 'open issue' })).toBe('Open issue')
  })
})

describe('HeaderRefBadge', () => {
  test('Given an overflow badge, Then it is one button whose name starts with its visible text and shows +N', () => {
    const html = render({ text: '#1738', status: 'open', extra: 2, action: 'show pull requests and issues' })
    expect(html).toMatch(/^<button/)
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-label="#1738, open, and 2 more: show pull requests and issues"')
    expect(html).toContain('#1738')
    expect(html).toContain('+2')
  })

  test('Given a lone item, Then no overflow count renders', () => {
    expect(render({ text: '#1738', action: 'open issue' })).not.toContain('+')
  })
})
