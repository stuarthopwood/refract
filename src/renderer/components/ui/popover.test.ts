import { describe, expect, test } from 'vitest'
import { hasClassToken } from './classToken'
import { POPOVER_CONTENT_CLASS } from './popover'

describe('popover panel (#2229)', () => {
  test('Given the panel, Then it paints the menu surface and never the popover fill', () => {
    expect(hasClassToken(POPOVER_CONTENT_CLASS, 'bg-menu-surface')).toBe(true)
    expect(hasClassToken(POPOVER_CONTENT_CLASS, 'bg-popover')).toBe(false)
  })
})
