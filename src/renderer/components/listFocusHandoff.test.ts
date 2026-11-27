// #2229: an inert reload must not drop focus from a row to the document body.
import { describe, expect, it } from 'vitest'
import { shouldHandOffFocus } from './listFocusHandoff'

describe('shouldHandOffFocus', () => {
  it('hands_focus_off_when_a_reload_locks_rows_that_hold_focus', () => {
    expect(shouldHandOffFocus(true, true)).toBe(true)
  })

  it('keeps_focus_when_it_is_outside_the_rows', () => {
    expect(shouldHandOffFocus(true, false)).toBe(false)
  })

  it('keeps_focus_when_nothing_locks_the_rows', () => {
    expect(shouldHandOffFocus(false, true)).toBe(false)
  })
})
