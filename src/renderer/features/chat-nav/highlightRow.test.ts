import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flashRowHighlight, NAV_HIGHLIGHT_ATTRIBUTE, NAV_HIGHLIGHT_MS } from './highlightRow'

const css = readFileSync(fileURLToPath(new URL('../../styles/globals.css', import.meta.url)), 'utf8')

function fakeRow(): HTMLElement {
  const attributes = new Set<string>()
  return {
    offsetWidth: 0,
    setAttribute: (name: string) => void attributes.add(name),
    removeAttribute: (name: string) => void attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name)
  } as unknown as HTMLElement
}

describe('flashRowHighlight', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('flash_sets_attribute_on_non_message_row', () => {
    const row = fakeRow()

    flashRowHighlight(row)
    expect(row.hasAttribute(NAV_HIGHLIGHT_ATTRIBUTE)).toBe(true)

    vi.advanceTimersByTime(NAV_HIGHLIGHT_MS)
    expect(row.hasAttribute(NAV_HIGHLIGHT_ATTRIBUTE)).toBe(false)
  })
})

describe('nav-highlight css', () => {
  it('highlight_rule_is_not_tied_to_message_rows', () => {
    expect(css).toMatch(/^\[data-nav-highlight\] \{\s*outline: 2px solid var\(--ring\);/m)
    expect(css).toMatch(/^ {2}:root:not\(\[data-reduce-motion='on'\]\) \[data-nav-highlight\] \{\s*animation: nav-highlight-fade/m)
    expect(css).not.toContain("[data-slot='message-scroller-item'][data-nav-highlight]")
  })

  it('checklist_row_outline_sits_inside_the_row', () => {
    expect(css).toMatch(/\[data-slot='checklist-row'\]\[data-nav-highlight\] \{\s*outline-offset: -2px;/)
  })
})
