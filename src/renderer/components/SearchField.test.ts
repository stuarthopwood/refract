// The repo has no DOM, so the field renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SearchField, type SearchFieldProps } from './SearchField'
import { TooltipProvider } from '@/components/ui/tooltip'

const base: SearchFieldProps = { value: '', onValueChange: () => undefined, label: 'Filter models', placeholder: 'Filter models…' }
const render = (props: Partial<SearchFieldProps> = {}): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SearchField, { ...base, ...props })))
const inputTag = (html: string): string => html.match(/<input[^>]*>/)?.[0] ?? ''

describe('SearchField', () => {
  test('Given no combobox slot, Then the input is a searchbox with no listbox wiring', () => {
    const tag = inputTag(render())
    expect(tag).toContain('role="searchbox"')
    expect(tag).not.toContain('aria-controls')
    expect(tag).not.toContain('aria-expanded')
  })

  test('Given a combobox slot, Then the input is an expanded combobox over the listbox with the active option', () => {
    const tag = inputTag(render({ combobox: { listboxId: 'models', activeDescendantId: 'models-3' } }))
    expect(tag).toContain('role="combobox"')
    expect(tag).toContain('aria-autocomplete="list"')
    expect(tag).toContain('aria-expanded="true"')
    expect(tag).toContain('aria-controls="models"')
    expect(tag).toContain('aria-activedescendant="models-3"')
  })

  test('Given a combobox slot without an active option, Then aria-activedescendant is left off', () => {
    expect(inputTag(render({ combobox: { listboxId: 'models' } }))).not.toContain('aria-activedescendant')
  })

  test('Given a list filter, Then the placeholder states the three-character rule and the field keeps the shared radius', () => {
    const tag = inputTag(render())
    expect(tag).toContain('placeholder="Filter models… (3+ characters)"')
    expect(tag).not.toMatch(/rounded-\[/)
  })

  test('Given a resultCount, Then the polite result status is mounted; without one, or when instant, it is not', () => {
    expect(render({ resultCount: 4 })).toContain('data-slot="filter-result-status"')
    expect(render()).not.toContain('data-slot="filter-result-status"')
    expect(render({ resultCount: 4, instant: true })).not.toContain('data-slot="filter-result-status"')
  })

  test.each([
    { escapeClears: undefined, shown: true },
    { escapeClears: true, shown: true },
    { escapeClears: false, shown: false }
  ])('Given a value and escapeClears=$escapeClears, Then the Escape-to-clear description shown is $shown', ({ escapeClears, shown }) => {
    const html = render({ value: 'abc', escapeClears })
    expect(html.includes('Press Escape to clear')).toBe(shown)
    expect(inputTag(html).includes('aria-describedby')).toBe(true)
  })

  test('Given escapeClears=false and the rule hint, Then the input describes only the rule, not a clear hint', () => {
    const html = render({ value: 'abc', escapeClears: false })
    const ids = inputTag(html).match(/aria-describedby="([^"]*)"/)?.[1]?.split(' ') ?? []
    expect(ids).toHaveLength(1)
  })
})
