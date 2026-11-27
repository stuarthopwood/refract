import { describe, expect, it, vi } from 'vitest'

// The real `@/state` barrel registers dev stores on `window`, which the node test environment lacks.
vi.mock('@/state', () => ({ useChatScrollStore: { getState: () => ({ record: () => {} }) } }))
import { FollowHarness, type FakeRow } from '../chat/scrollTestHarness'
import { jumpTopInset } from './jumpTopInset'
import { startRowJumpLoop, type JumpControl } from './rowJumpLoop'

const TARGET_OFFSET = 1000

function jumpSetup(library: 'follows' | 'drags-always' = 'drags-always') {
  const harness = new FollowHarness({ library })
  harness.install()
  const state = { turnRunning: true }
  const onLanded = vi.fn()
  const control: JumpControl = {
    jumpCancelRef: { current: null },
    jumpTokenRef: { current: 0 },
    landingInProgressRef: harness.landingRef,
    resetGesture: () => {},
    setAutoScrollSuppressed: (suppressed) => harness.follow.setState({ suppressed }),
    setIsAtEnd: (isAtEnd) => harness.follow.setState({ isAtEnd }),
    markNewContent: () => harness.follow.setState({ newContent: true }),
    isTurnRunning: () => state.turnRunning
  }
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
  return { harness, state, control, onLanded, jump, targetTop, rowInView }
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
    const { harness: h, control, jump } = jumpSetup('follows')
    jump(h.viewport.addRow(TARGET_OFFSET))
    h.frames(SETTLE_FRAMES)

    control.jumpCancelRef.current?.()
    h.landingRef.current = false
    h.follow.scrollToEnd()
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
