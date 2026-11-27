import { describe, expect, it, vi } from 'vitest'

// The real `@/state` barrel registers dev stores on `window`, which the node test environment lacks.
vi.mock('@/state', () => ({ useChatScrollStore: { getState: () => ({ record: () => {} }) } }))
import { FollowHarness, type FakeRow } from '../chat/scrollTestHarness'
import { jumpTopInset } from './jumpTopInset'
import { startRowJumpLoop } from './rowJumpLoop'

const TARGET_OFFSET = 1000

function jumpSetup() {
  const harness = new FollowHarness({ library: 'follows' })
  harness.install()
  const onLanded = vi.fn()
  const control = harness.scroll.jumpControl
  const jump = (row: FakeRow) =>
    startRowJumpLoop({
      sessionId: 'session-1021',
      root: harness.root as unknown as HTMLElement,
      viewport: harness.viewport as unknown as HTMLElement,
      row: row as unknown as HTMLElement,
      control,
      onLanded
    })
  const targetTop = (row: FakeRow) => row.offset - jumpTopInset(harness.viewport as unknown as HTMLElement)
  return { harness, onLanded, jump, targetTop }
}

/** Frames enough for the jump loop to reach its settle. */
const SETTLE_FRAMES = 4

describe('a jump away from the end during a streaming turn (#1021)', () => {
  it('keeps the target where it landed because autoScroll is off, so the scroller does not drag back', () => {
    const { harness: h, jump, targetTop, onLanded } = jumpSetup()
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    expect(h.viewport.scrollTop).toBe(targetTop(row))
    expect(onLanded).toHaveBeenCalledTimes(1)
    expect(h.landingRef.current).toBe(false)

    for (let i = 0; i < 6; i += 1) {
      h.stream(400)
      h.frame()
      expect(h.viewport.scrollTop).toBe(targetTop(row))
    }
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })

  it('shows the new-content cue as the turn keeps growing below the target', () => {
    const { harness: h, jump } = jumpSetup()
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.frames(SETTLE_FRAMES)
    expect(h.follow.getState().newContent).toBe(false)
    h.stream(300)
    h.frame()
    expect(h.follow.getState().newContent).toBe(true)
  })

  it('does not drag the view back after a user wheel', () => {
    const { harness: h, jump } = jumpSetup()
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.frames(SETTLE_FRAMES)
    h.stream(300)
    h.frame()

    h.root.dispatch('wheel', h.viewport)
    h.userScrollUp(120)
    const parked = h.viewport.scrollTop
    h.stream(300)
    h.frames(3)
    expect(h.viewport.scrollTop).toBe(parked)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })

  it('follows the stream again after Scroll to end', () => {
    const { harness: h, jump } = jumpSetup()
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.frames(SETTLE_FRAMES)

    h.scroll.scrollToEnd()
    h.frame()
    h.stream(300)
    h.frames(3)
    expect(h.viewport.distanceFromEnd).toBe(0)
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true })
  })

  it('lets a newer jump take over', () => {
    const { harness: h, jump, targetTop } = jumpSetup()
    const first = h.viewport.addRow(TARGET_OFFSET)
    const second = h.viewport.addRow(1800)
    jump(first)
    h.frames(SETTLE_FRAMES)
    h.stream(200)
    h.frame()

    jump(second)
    h.frames(SETTLE_FRAMES)
    h.stream(200)
    h.frames(2)
    expect(h.viewport.scrollTop).toBe(targetTop(second))
  })

  it('follows a jump that lands at the end', () => {
    const { harness: h, jump } = jumpSetup()
    jump(h.viewport.addRow(h.viewport.contentHeight - 100))
    h.frames(SETTLE_FRAMES)
    expect(h.follow.getState().isAtEnd).toBe(true)
    h.stream(300)
    h.frame()
    expect(h.landingRef.current).toBe(false)
    expect(h.viewport.distanceFromEnd).toBe(0)
  })
})

describe('after a settled jump (#1021)', () => {
  const USER = { kind: 'user', id: 'u1' }
  const REPLY = { kind: 'assistant', id: 'a1' }

  function settledJump() {
    const setup = jumpSetup()
    setup.jump(setup.harness.viewport.addRow(TARGET_OFFSET))
    setup.harness.frames(SETTLE_FRAMES)
    setup.harness.stream(300)
    setup.harness.frame()
    return setup
  }

  it('follows the stream when the user sends a message, through the controller Transcript uses', () => {
    const { harness: h } = settledJump()
    h.scroll.noteItems('s:0', [USER, REPLY])
    h.scroll.noteItems('s:0', [USER, REPLY, { kind: 'user', id: 'u2' }])
    h.frame()
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true })
    h.stream(300)
    h.frames(3)
    expect(h.viewport.distanceFromEnd).toBe(0)
  })

  it('stays detached when a different Session replaces the items rather than sending', () => {
    const { harness: h } = settledJump()
    h.scroll.noteItems('s1:0', [USER, REPLY])
    h.scroll.noteItems('s2:0', [{ kind: 'user', id: 'other' }])
    h.frame()
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })

  it('stays where a navigation key such as PageUp leaves the view', () => {
    const { harness: h } = settledJump()
    h.root.dispatch('keydown', h.viewport, 'PageUp')
    h.userScrollUp(200)
    const parked = h.viewport.scrollTop
    h.stream(300)
    h.frames(3)
    expect(h.viewport.scrollTop).toBe(parked)
  })
})

describe('the new-content cue around a jump (#459)', () => {
  it('does not read growth during a landing as new content when the landing ends', () => {
    const { harness: h, jump } = jumpSetup()
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.viewport.contentHeight += 400
    h.frames(SETTLE_FRAMES + 1)
    expect(h.landingRef.current).toBe(false)
    h.resizeViewport(500)
    h.frame()
    expect(h.follow.getState().newContent).toBe(false)
  })

  it('forgets the old height when a different Session takes the viewport', () => {
    const { harness: h } = jumpSetup()
    h.scroll.beginLanding({ atEnd: false, scrollTop: 500 })
    h.viewport.contentHeight = 5000
    h.landingRef.current = false
    h.follow.handleResize()
    expect(h.follow.getState().newContent).toBe(false)
  })
})
