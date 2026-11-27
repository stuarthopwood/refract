// The repo has no DOM, so the field renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SearchField, type SearchFieldProps } from './SearchField'

const base: SearchFieldProps = { value: '', onValueChange: () => undefined, label: 'Filter models', placeholder: 'Filter models…' }
const render = (props: Partial<SearchFieldProps> = {}): string => renderToStaticMarkup(createElement(SearchField, { ...base, ...props }))
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
})
