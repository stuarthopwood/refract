import { describe, expect, test } from 'vitest'
import { hasClassToken } from './classToken'
import { SELECT_CONTENT_CLASS, SELECT_ITEM_CLASS, SELECT_TRIGGER_CLASS } from './select'

describe('SELECT_TRIGGER_CLASS', () => {
  test.each([
    'aria-disabled:cursor-not-allowed',
    'aria-disabled:opacity-50',
    'aria-disabled:hover:bg-transparent',
    'dark:aria-disabled:hover:bg-transparent'
  ])('Given a trigger that is aria-disabled, Then it carries %s so every dropdown looks inert without being disabled', (token) => {
    expect(SELECT_TRIGGER_CLASS.split(' ')).toContain(token)
  })
})

describe('select panel (#2229)', () => {
  test('Given the panel, Then it paints the menu surface and never the popover fill', () => {
    expect(hasClassToken(SELECT_CONTENT_CLASS, 'bg-menu-surface')).toBe(true)
    expect(hasClassToken(SELECT_CONTENT_CLASS, 'bg-popover')).toBe(false)
  })

  test('Given a focused row, Then it fills with the hover wash, not the accent', () => {
    expect(hasClassToken(SELECT_ITEM_CLASS, 'focus:bg-menu-hover')).toBe(true)
    expect(hasClassToken(SELECT_ITEM_CLASS, 'focus:bg-accent')).toBe(false)
    expect(hasClassToken(SELECT_ITEM_CLASS, 'focus:text-accent-foreground')).toBe(false)
  })

  test('Given forced colours, Then a focused row gets the Highlight outline the menu rows use', () => {
    expect(hasClassToken(SELECT_ITEM_CLASS, 'forced-colors:focus:outline-(length:--focus-ring-width)')).toBe(true)
    expect(hasClassToken(SELECT_ITEM_CLASS, 'forced-colors:focus:outline-[color:Highlight]')).toBe(true)
  })
})
