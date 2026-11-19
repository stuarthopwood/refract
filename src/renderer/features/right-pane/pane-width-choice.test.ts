import { describe, expect, it } from 'vitest'
import { choiceText, widthShowsOneChat } from './pane-width-choice'

// 1400 px group, 220 px Session list: 1180 px for chat plus the pane.
const layout = { groupWidthPx: 1400, sessionListPx: 220 }

describe('widthShowsOneChat', () => {
  it('Given a Split and a width that leaves two 360 px panes, Then there is no warning', () => {
    expect(widthShowsOneChat({ widthPx: 460, isSplit: true, layout })).toBe(false)
  })

  it('Given a Split and a width that leaves chat under 720 px, Then the choice shows one chat', () => {
    expect(widthShowsOneChat({ widthPx: 640, isSplit: true, layout })).toBe(true)
  })

  it('Given the exact limit, Then both panes still fit', () => {
    expect(widthShowsOneChat({ widthPx: 460, isSplit: true, layout: { groupWidthPx: 1400, sessionListPx: 220 } })).toBe(false)
    expect(widthShowsOneChat({ widthPx: 461, isSplit: true, layout })).toBe(true)
  })

  it('Given a single chat, Then no width warns', () => {
    expect(widthShowsOneChat({ widthPx: 640, isSplit: false, layout })).toBe(false)
  })

  it('Given an unmeasurable layout, Then it never warns on a guess', () => {
    expect(widthShowsOneChat({ widthPx: 640, isSplit: true, layout: null })).toBe(false)
  })
})

describe('choiceText', () => {
  it('Given a plain choice, Then it reads label and width', () => {
    expect(choiceText({ label: 'Wide', widthPx: 640, shownAsOneChat: false })).toBe('Wide (640 px)')
  })

  it('Given a choice that drops the Split, Then it says it shows one chat', () => {
    expect(choiceText({ label: 'Wide', widthPx: 640, shownAsOneChat: true })).toBe('Wide (640 px) (shows one chat)')
  })
})
