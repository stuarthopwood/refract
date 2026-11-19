import { describe, expect, it } from 'vitest'
import { EMPTY_PANE_FOCUS_SELECTORS, firstMatch, isFocusStranded, shouldRestoreFocusAfterSwitch } from './pane-focus-targets'

describe('firstMatch', () => {
  it('prefers the launcher row over the rail toggle', () => {
    const found = firstMatch(EMPTY_PANE_FOCUS_SELECTORS, (selector) => selector)
    expect(found).toBe('[data-panel-launcher] button')
  })

  it('falls back to the rail toggle when no launcher row is mounted', () => {
    expect(firstMatch(EMPTY_PANE_FOCUS_SELECTORS, (selector) => (selector === '[data-rail-toggle]' ? selector : null))).toBe('[data-rail-toggle]')
  })

  it('finds nothing when no selector matches', () => {
    expect(firstMatch(EMPTY_PANE_FOCUS_SELECTORS, () => null)).toBeNull()
  })
})

describe('isFocusStranded', () => {
  const body = {}
  it('is stranded on the body, on nothing and on a detached element', () => {
    expect(isFocusStranded(null, body)).toBe(true)
    expect(isFocusStranded(body as { isConnected: boolean }, body)).toBe(true)
    expect(isFocusStranded({ isConnected: false }, body)).toBe(true)
  })

  it('is not stranded on a mounted element', () => {
    expect(isFocusStranded({ isConnected: true }, body)).toBe(false)
  })
})

describe('shouldRestoreFocusAfterSwitch', () => {
  it('restores only for a Session switch that took focus off the strip', () => {
    expect(shouldRestoreFocusAfterSwitch(true, true, true)).toBe(true)
    expect(shouldRestoreFocusAfterSwitch(false, true, true)).toBe(false)
    expect(shouldRestoreFocusAfterSwitch(true, false, true)).toBe(false)
    expect(shouldRestoreFocusAfterSwitch(true, true, false)).toBe(false)
  })
})
