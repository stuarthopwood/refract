// The repo has no DOM, so the primitives render to a string. A read-only, aria-disabled field is how locked forms stay focusable.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Input } from './input'
import { NumberField } from './NumberField'
import { Textarea } from './textarea'

const DIMMED = ['aria-disabled:cursor-not-allowed', 'aria-disabled:bg-field-hover-bg', 'aria-disabled:opacity-50']

describe('locked text controls', () => {
  test.each([
    ['Input', () => createElement(Input, { readOnly: true, 'aria-disabled': true })],
    ['Textarea', () => createElement(Textarea, { readOnly: true, 'aria-disabled': true })],
    ['NumberField', () => createElement(NumberField, { readOnly: true, 'aria-disabled': true, value: '5' })]
  ])('Given a read-only aria-disabled %s, Then it carries the dimmed, not-allowed styles', (_name, make) => {
    const html = renderToStaticMarkup(make())
    expect(html).toContain('aria-disabled="true"')
    for (const style of DIMMED) expect(html).toContain(style)
  })
})
