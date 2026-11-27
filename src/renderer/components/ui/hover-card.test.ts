import { describe, expect, it, vi } from 'vitest'
import { createClickSuppression } from './hoverCardSuppression'

function setup() {
  const close = vi.fn()
  const suppression = createClickSuppression(close)
  const focus = () => {
    const event = { preventDefault: vi.fn() }
    suppression.onFocus(event)
    return event
  }
  return { suppression, close, focus }
}

describe('hover card click suppression (issue #1760, FR-192)', () => {
  it('lets a resting pointer open the card before any click', () => {
    const { suppression } = setup()
    expect(suppression.blocksOpen()).toBe(false)
  })

  it('closes an open card and blocks reopening once the row is pressed', () => {
    const { suppression, close } = setup()
    suppression.onPointerDown()
    expect(close).toHaveBeenCalledTimes(1)
    expect(suppression.blocksOpen()).toBe(true)
  })

  it('keeps blocking while the pointer stays on the row after the click', () => {
    const { suppression } = setup()
    suppression.onPointerDown()
    suppression.onClick()
    expect(suppression.blocksOpen()).toBe(true)
  })

  it('allows the card again once the pointer leaves and returns', () => {
    const { suppression } = setup()
    suppression.onPointerDown()
    suppression.onClick()
    suppression.onPointerLeave()
    expect(suppression.blocksOpen()).toBe(false)
  })

  it('swallows the focus the click caused so Radix never opens from it', () => {
    const { suppression, focus } = setup()
    suppression.onPointerDown()
    const event = focus()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(suppression.blocksOpen()).toBe(true)
  })

  it('still opens for keyboard focus with no preceding click', () => {
    const { suppression, focus } = setup()
    const event = focus()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(suppression.blocksOpen()).toBe(false)
  })

  it('opens for keyboard focus after a click even while the pointer still rests on the row', () => {
    const { suppression, focus } = setup()
    suppression.onPointerDown()
    focus() // the click's own focus
    suppression.onClick()
    const keyboardFocus = focus()
    expect(keyboardFocus.preventDefault).not.toHaveBeenCalled()
    expect(suppression.blocksOpen()).toBe(false)
  })

  it('does not swallow a later keyboard focus when the click caused no focus event (already focused)', () => {
    const { suppression, focus } = setup()
    suppression.onPointerDown()
    suppression.onClick()
    const keyboardFocus = focus()
    expect(keyboardFocus.preventDefault).not.toHaveBeenCalled()
  })
})
