import { describe, expect, it, vi } from 'vitest'

// The real `@/state` barrel registers dev stores on `window`, which the node test environment lacks.
vi.mock('@/state', () => ({ useChatScrollStore: { getState: () => ({ record: () => {} }) } }))
import { FollowHarness, type FakeRow } from '../chat/scrollTestHarness'
import { jumpTopInset } from './jumpTopInset'
import { startRowJumpLoop } from './rowJumpLoop'

const TARGET_OFFSET = 1000

function jumpSetup(library: 'follows' | 'drags-always' = 'drags-always') {
  const harness = new FollowHarness({ library })
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
  const rowInView = (row: FakeRow) => {
    const { top } = row.getBoundingClientRect()
    return top >= 0 && top < harness.viewport.clientHeight
  }
  return { harness, state: harness, control, onLanded, jump, targetTop, rowInView }
}

/** Frames enough for the jump loop to reach its first settle. */
const SETTLE_FRAMES = 4

describe('a jump away from the end during a streaming turn (#1021)', () => {
  it('holds the target in view while later content streams in', () => {
    const { harness: h, jump, targetTop, rowInView } = jumpSetup()
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    expect(h.viewport.scrollTop).toBe(targetTop(row))

    for (let i = 0; i < 6; i += 1) {
      h.stream(400)
      h.frame()
      expect(rowInView(row)).toBe(true)
      expect(h.viewport.scrollTop).toBe(targetTop(row))
    }
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })

  it('shows the new-content cue as the held turn keeps growing', () => {
    const { harness: h, jump } = jumpSetup()
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.frames(SETTLE_FRAMES)
    expect(h.follow.getState().newContent).toBe(false)
    h.stream(300)
    h.frame()
    expect(h.follow.getState().newContent).toBe(true)
  })

  it('lets go when the turn settles and leaves the position to the reader', () => {
    const { harness: h, state, jump, targetTop, onLanded } = jumpSetup()
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    h.stream(300)
    h.frame()
    state.turnRunning = false
    h.frame()
    expect(h.landingRef.current).toBe(false)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
    expect(onLanded).toHaveBeenCalledTimes(1)

    h.viewport.scrollTop = targetTop(row) + 80
    h.frames(3)
    expect(h.viewport.scrollTop).toBe(targetTop(row) + 80)
  })

  it('detaches at once on a user wheel and nothing drags the view back', () => {
    const { harness: h, jump } = jumpSetup('follows')
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    h.stream(300)
    h.frame()

    h.root.dispatch('wheel', h.viewport)
    h.userScrollUp(120)
    const parked = h.viewport.scrollTop
    h.stream(300)
    h.frames(3)
    expect(h.landingRef.current).toBe(false)
    expect(h.viewport.scrollTop).toBe(parked)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })

  it('ends the hold on Scroll to end and follows the stream again', () => {
    const { harness: h, jump } = jumpSetup('follows')
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.frames(SETTLE_FRAMES)

    h.scroll.scrollToEnd()
    h.frame()
    h.stream(300)
    h.frames(3)
    expect(h.viewport.distanceFromEnd).toBe(0)
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true })
  })

  it('lets a newer jump take over the hold', () => {
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

  it('does not hold a jump that lands at the end, where following already keeps up', () => {
    const { harness: h, jump } = jumpSetup('follows')
    jump(h.viewport.addRow(h.viewport.contentHeight - 100))
    h.frames(SETTLE_FRAMES)
    expect(h.follow.getState().isAtEnd).toBe(true)
    h.stream(300)
    h.frame()
    expect(h.landingRef.current).toBe(false)
    expect(h.viewport.distanceFromEnd).toBe(0)
  })
})

describe('a jump in a settled turn (#1008)', () => {
  it('settles after a few frames and does not hold', () => {
    const { harness: h, state, jump, targetTop, onLanded } = jumpSetup()
    state.turnRunning = false
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    expect(h.viewport.scrollTop).toBe(targetTop(row))
    expect(h.landingRef.current).toBe(false)
    expect(onLanded).toHaveBeenCalledTimes(1)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })
})

describe('what ends a hold (#1021)', () => {
  const USER = { kind: 'user', id: 'u1' }
  const REPLY = { kind: 'assistant', id: 'a1' }

  function heldJump(library: 'follows' | 'drags-always' = 'follows') {
    const setup = jumpSetup(library)
    const { harness: h, jump } = setup
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    h.stream(300)
    h.frame()
    expect(h.landingRef.current).toBe(true)
    return { ...setup, row }
  }

  it('ends when the user sends a message, through the controller Transcript uses, and follows the stream', () => {
    const { harness: h } = heldJump()
    h.scroll.noteItems('s:0', [USER, REPLY])
    h.scroll.noteItems('s:0', [USER, REPLY, { kind: 'user', id: 'u2' }])
    h.frame()
    expect(h.landingRef.current).toBe(false)
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true })
    h.stream(300)
    h.frames(3)
    expect(h.viewport.distanceFromEnd).toBe(0)
  })

  it('keeps the hold when a different Session replaces the items rather than sending', () => {
    const { harness: h } = heldJump('drags-always')
    h.scroll.noteItems('s1:0', [USER, REPLY])
    h.scroll.noteItems('s2:0', [{ kind: 'user', id: 'other' }])
    h.frame()
    expect(h.landingRef.current).toBe(true)
  })

  it('ends on a navigation key such as PageUp and nothing drags the view back', () => {
    const { harness: h } = heldJump()
    h.root.dispatch('keydown', h.viewport, 'PageUp')
    h.userScrollUp(200)
    const parked = h.viewport.scrollTop
    h.stream(300)
    h.frames(3)
    expect(h.landingRef.current).toBe(false)
    expect(h.viewport.scrollTop).toBe(parked)
  })

  it('ignores a key that does not scroll', () => {
    const { harness: h } = heldJump()
    h.root.dispatch('keydown', h.viewport, 'a')
    h.frame()
    expect(h.landingRef.current).toBe(true)
  })

  it('ends on a scroll that nothing explains, as voice control or switch access cause', () => {
    const { harness: h, row, targetTop } = heldJump('follows')
    h.viewport.scrollTop = targetTop(row) - 200
    h.frame()
    const parked = h.viewport.scrollTop
    expect(h.landingRef.current).toBe(false)
    h.stream(300)
    h.frames(3)
    expect(h.viewport.scrollTop).toBe(parked)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
  })

  it('keeps the hold through the scroll events its own writes and growth cause', () => {
    const { harness: h } = heldJump('drags-always')
    for (let i = 0; i < 4; i += 1) {
      h.stream(250)
      h.frame()
    }
    expect(h.landingRef.current).toBe(true)
  })
})

describe('the new-content cue around a hold (#459, #1021)', () => {
  it('ignores growth above the held target, which adds nothing the reader has yet to see', () => {
    const { harness: h, jump, targetTop } = jumpSetup('drags-always')
    const row = h.viewport.addRow(TARGET_OFFSET)
    jump(row)
    h.frames(SETTLE_FRAMES)
    h.viewport.contentHeight += 200
    row.offset += 200
    h.frame()
    expect(h.viewport.scrollTop).toBe(targetTop(row))
    expect(h.follow.getState().newContent).toBe(false)
  })

  it('does not read growth during a landing as new content when the landing ends', () => {
    const { harness: h, state, jump } = jumpSetup('follows')
    state.turnRunning = false
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.viewport.contentHeight += 400
    h.frames(SETTLE_FRAMES + 1)
    expect(h.landingRef.current).toBe(false)
    h.resizeViewport(500)
    h.frame()
    expect(h.follow.getState().newContent).toBe(false)
  })

  it('forgets the old height when a different Session takes the viewport', () => {
    const { harness: h } = jumpSetup('follows')
    h.scroll.beginLanding({ atEnd: false, scrollTop: 500 })
    h.viewport.contentHeight = 5000
    h.landingRef.current = false
    h.follow.handleResize()
    expect(h.follow.getState().newContent).toBe(false)
  })
})
