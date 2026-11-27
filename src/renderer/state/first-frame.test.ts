import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIRST_FRAME_FALLBACK_MS,
  afterFirstFrame,
  openGateAfterFirstFrame,
  resetFirstFrameGateForTests
} from './first-frame'

let frame: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  frame = null
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frame = callback
    return 1
  })
  resetFirstFrameGateForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('afterFirstFrame', () => {
  it('runs_nothing_until_the_first_frame_has_painted', () => {
    const task = vi.fn()
    afterFirstFrame(task)
    openGateAfterFirstFrame()
    vi.advanceTimersByTime(0)
    expect(task).not.toHaveBeenCalled()
    // The animation frame callback runs before the paint, so the task still waits for the timeout inside it.
    frame?.()
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('runs_queued_tasks_in_registration_order_and_later_tasks_at_once', () => {
    const order: string[] = []
    afterFirstFrame(() => order.push('first'))
    afterFirstFrame(() => order.push('second'))
    openGateAfterFirstFrame()
    frame?.()
    vi.advanceTimersByTime(0)
    afterFirstFrame(() => order.push('late'))
    expect(order).toEqual(['first', 'second', 'late'])
  })

  it('still_starts_when_the_frame_never_fires_in_a_hidden_window', () => {
    const task = vi.fn()
    afterFirstFrame(task)
    openGateAfterFirstFrame()
    vi.advanceTimersByTime(FIRST_FRAME_FALLBACK_MS)
    expect(task).toHaveBeenCalledTimes(1)
    frame?.()
    vi.advanceTimersByTime(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('a_throwing_task_does_not_block_the_rest', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    afterFirstFrame(() => {
      throw new Error('boom')
    })
    afterFirstFrame(after)
    openGateAfterFirstFrame()
    frame?.()
    vi.advanceTimersByTime(0)
    expect(after).toHaveBeenCalledTimes(1)
  })
})
