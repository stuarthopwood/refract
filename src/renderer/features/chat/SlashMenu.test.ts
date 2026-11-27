import { describe, expect, test } from 'vitest'
import { hasClassToken } from '@/components/ui/classToken'
import { COMPOSER_MENU_LIST_CLASS, COMPOSER_MENU_NOTICE_CLASS, composerMenuRowClass } from './SlashMenu'

describe('composer menus (#2229)', () => {
  test.each([COMPOSER_MENU_LIST_CLASS, COMPOSER_MENU_NOTICE_CLASS])('Given a slash or # panel, Then it paints the menu surface and never the popover fill', (panel) => {
    expect(hasClassToken(panel, 'bg-menu-surface')).toBe(true)
    expect(hasClassToken(panel, 'bg-popover')).toBe(false)
  })

  test('Given the active row, Then it uses the hover wash with foreground text and keeps the indicator border', () => {
    const active = composerMenuRowClass(true)
    expect(hasClassToken(active, 'bg-menu-hover')).toBe(true)
    expect(hasClassToken(active, 'text-foreground')).toBe(true)
    expect(hasClassToken(active, 'border-l-active-indicator')).toBe(true)
    expect(hasClassToken(active, 'bg-accent')).toBe(false)
    expect(hasClassToken(active, 'text-accent-foreground')).toBe(false)
  })

  test('Given an inactive row, Then it carries no fill', () => {
    expect(hasClassToken(composerMenuRowClass(false), 'bg-menu-hover')).toBe(false)
  })
})
