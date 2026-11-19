import { describe, expect, it } from 'vitest'
import { nextHandleFocus, shouldRescueHandleFocus } from './resize-handle-focus'

describe('nextHandleFocus', () => {
  it('Given the handle is enabled, Then focus and blur follow the user', () => {
    expect(nextHandleFocus(false, 'focus', false)).toBe(true)
    expect(nextHandleFocus(true, 'blur', false)).toBe(false)
  })

  it('Given the handle just became disabled, Then its blur is not the user leaving it', () => {
    expect(nextHandleFocus(true, 'blur', true)).toBe(true)
  })
})

describe('shouldRescueHandleFocus', () => {
  it('Given a disabled handle that held focus, Then the focus is rescued', () => {
    expect(shouldRescueHandleFocus({ handleDisabled: true, hadFocus: true })).toBe(true)
  })

  it('Given a disabled handle that never had focus, Then nothing moves', () => {
    expect(shouldRescueHandleFocus({ handleDisabled: true, hadFocus: false })).toBe(false)
  })

  it('Given an enabled handle, Then nothing moves', () => {
    expect(shouldRescueHandleFocus({ handleDisabled: false, hadFocus: true })).toBe(false)
  })
})
