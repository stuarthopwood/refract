import { describe, expect, it } from 'vitest'
import { SCROLL_END_TOLERANCE_PX } from './scrollLanding'
import { isNewSend } from './scrollFollow'
import { FollowHarness } from './scrollTestHarness'

function attachedHarness(library: 'follows' | 'misses-late' = 'misses-late') {
  const harness = new FollowHarness({ library })
  harness.install()
  return harness
}

describe('stick to the end while attached (#459)', () => {
  it('keeps the end in view while text streams in', () => {
    const h = attachedHarness('follows')
    for (let i = 0; i < 20; i += 1) {
      h.stream(120)
      h.frame()
    }
    expect(h.viewport.distanceFromEnd).toBeLessThanOrEqual(SCROLL_END_TOLERANCE_PX)
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true })
  })

  it('keeps the end in view after a late height change the library does not follow (Shiki swap, tool-group merge)', () => {
    const h = attachedHarness()
    h.stream(200)
    h.frame()
    h.lateHeightChange(400)
    h.frame()
    expect(h.viewport.distanceFromEnd).toBeLessThanOrEqual(SCROLL_END_TOLERANCE_PX)
  })

  it('re-pins an attached transcript when the panel opens or the window shrinks', () => {
    const h = attachedHarness()
    h.resizeViewport(380)
    h.frame()
    expect(h.viewport.distanceFromEnd).toBeLessThanOrEqual(SCROLL_END_TOLERANCE_PX)
  })
})

describe('detached transcripts are left alone (#459)', () => {
  it('detaches on an upward gesture and does not follow streamed or late growth', () => {
    const h = attachedHarness()
    h.userScrollUp(900)
    const parked = h.viewport.scrollTop
    h.stream(300)
    h.lateHeightChange(300)
    h.resizeViewport(420)
    h.frames(3)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, isAtEnd: false })
    expect(h.viewport.scrollTop).toBe(parked)
  })

  it('shows the new-content cue only after content grows post-detach, and clears it on re-attach', () => {
    const h = attachedHarness()
    h.userScrollUp(900)
    expect(h.follow.getState().newContent).toBe(false)
    h.stream(200)
    h.frame()
    expect(h.follow.getState().newContent).toBe(true)
    h.userScrollDownToEnd()
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true, newContent: false })
  })

  it('does not count the user expanding a row as new content and does not move the viewport', () => {
    const h = attachedHarness()
    h.userScrollUp(900)
    const parked = h.viewport.scrollTop
    h.expandRow(250)
    expect(h.viewport.scrollTop).toBe(parked)
    expect(h.follow.getState()).toMatchObject({ suppressed: true, newContent: false })
  })

  it('follows an expand while attached', () => {
    const h = attachedHarness()
    h.expandRow(250)
    expect(h.viewport.distanceFromEnd).toBeLessThanOrEqual(SCROLL_END_TOLERANCE_PX)
  })
})

describe('a send always follows (#459)', () => {
  it('recognises a freshly appended user message as a send', () => {
    const before = [{ kind: 'assistant-text', id: 'a1' }]
    const after = [...before, { kind: 'user', id: 'u1' }]
    expect(isNewSend(before, after)).toBe(true)
  })

  it('ignores streaming growth, a resumed transcript and a re-render of the same user message', () => {
    const user = { kind: 'user', id: 'u1' }
    expect(isNewSend([user], [user, { kind: 'assistant-text', id: 'a1' }])).toBe(false)
    expect(isNewSend([user], [user])).toBe(false)
    expect(isNewSend([], [])).toBe(false)
  })

  it('re-attaches from a detached state and keeps following the reply', () => {
    const h = attachedHarness('follows')
    h.userScrollUp(1200)
    h.stream(200)
    h.frame()
    expect(h.follow.getState().newContent).toBe(true)
    h.follow.scrollToEnd()
    h.frame()
    h.stream(300)
    h.frame()
    expect(h.viewport.distanceFromEnd).toBeLessThanOrEqual(SCROLL_END_TOLERANCE_PX)
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true, newContent: false })
  })
})

describe('Scroll to end motion (#459)', () => {
  it('jumps at once under reduced motion', () => {
    const h = attachedHarness('follows')
    h.userScrollUp(500)
    h.reducedMotion = true
    h.follow.scrollToEnd()
    expect(h.viewport.distanceFromEnd).toBe(0)
  })

  it('glides a short distance, keeps the button hidden while gliding and ends attached', () => {
    const h = attachedHarness('follows')
    h.userScrollUp(500)
    h.reducedMotion = false
    h.follow.scrollToEnd()
    expect(h.viewport.distanceFromEnd).toBeGreaterThan(0)
    h.frame()
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true })
    h.frames(4)
    expect(h.viewport.distanceFromEnd).toBe(0)
    expect(h.follow.getState()).toMatchObject({ suppressed: false, isAtEnd: true, newContent: false })
  })

  it('jumps at once when the end is more than two viewports away', () => {
    const h = attachedHarness('follows')
    h.userScrollUp(1500)
    h.reducedMotion = false
    h.follow.scrollToEnd()
    expect(h.viewport.distanceFromEnd).toBe(0)
  })
})
