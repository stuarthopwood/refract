import { describe, expect, it } from 'vitest'
import { JUMP_SCROLL_TOP_MARGIN_PX } from '../chat/stageJump'
import { jumpTopInset, trackOpenFindBar } from './jumpTopInset'

const FIND_BAR_GAP_PX = 24
const BAR_BOTTOM_PX = 80

/** A viewport whose pane holds a Find bar whose bottom edge sits `BAR_BOTTOM_PX` below the pane top (and the viewport top, 0). */
function viewportWithBar(): HTMLElement {
  const bar = { getBoundingClientRect: () => ({ bottom: BAR_BOTTOM_PX }) }
  const pane = { querySelector: (selector: string) => (selector === '[data-chat-find]' ? bar : null) }
  return {
    closest: (selector: string) => (selector === '[data-session-pane]' ? pane : null),
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
}

const CLEARS_BAR = BAR_BOTTOM_PX + FIND_BAR_GAP_PX

describe('where a chat-navigation jump lands its target (#459)', () => {
  it('uses the plain margin while no Find bar is open, even if a stale bar element is in the pane', () => {
    expect(jumpTopInset(viewportWithBar())).toBe(JUMP_SCROLL_TOP_MARGIN_PX)
  })

  it('lands below the bar while one Find bar is open', () => {
    const release = trackOpenFindBar()
    try {
      expect(jumpTopInset(viewportWithBar())).toBe(CLEARS_BAR)
    } finally {
      release()
    }
  })

  it('returns to the plain margin once the bar is closed, after the bar mounts and unmounts twice', () => {
    for (let i = 0; i < 2; i += 1) {
      const release = trackOpenFindBar()
      expect(jumpTopInset(viewportWithBar())).toBe(CLEARS_BAR)
      release()
    }
    expect(jumpTopInset(viewportWithBar())).toBe(JUMP_SCROLL_TOP_MARGIN_PX)
  })

  it('keeps clearing the bar while a second bar is still open after the first closes', () => {
    const releaseFirst = trackOpenFindBar()
    const releaseSecond = trackOpenFindBar()
    releaseFirst()
    expect(jumpTopInset(viewportWithBar())).toBe(CLEARS_BAR)
    releaseSecond()
    expect(jumpTopInset(viewportWithBar())).toBe(JUMP_SCROLL_TOP_MARGIN_PX)
  })
})
