import { describe, expect, test } from 'vitest'
import { hasClassToken } from './classToken'
import { COMMAND_CLASS, COMMAND_ITEM_CLASS } from './command'

describe('command palette (#2229)', () => {
  test('Given the palette, Then it paints the menu surface and never the popover fill', () => {
    expect(hasClassToken(COMMAND_CLASS, 'bg-menu-surface')).toBe(true)
    expect(hasClassToken(COMMAND_CLASS, 'bg-popover')).toBe(false)
  })

  test('Given a selected row, Then it fills with the hover wash and keeps its ring, not the accent', () => {
    expect(hasClassToken(COMMAND_ITEM_CLASS, 'data-[selected=true]:bg-menu-hover')).toBe(true)
    expect(hasClassToken(COMMAND_ITEM_CLASS, 'data-[selected=true]:text-foreground')).toBe(true)
    expect(hasClassToken(COMMAND_ITEM_CLASS, 'data-[selected=true]:ring-ring')).toBe(true)
    expect(hasClassToken(COMMAND_ITEM_CLASS, 'data-[selected=true]:bg-accent')).toBe(false)
    expect(hasClassToken(COMMAND_ITEM_CLASS, 'data-[selected=true]:text-accent-foreground')).toBe(false)
  })
})
