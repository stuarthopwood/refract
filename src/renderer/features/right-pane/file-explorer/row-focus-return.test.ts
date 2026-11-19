import { describe, expect, it, vi } from 'vitest'
import { pollUntilSettled, shouldReturnFocusToRow, takeClosedOrigins } from './row-focus-return'

const tabs = (...ids: string[]) => ({ tabs: ids.map((id) => ({ id })) })

describe('takeClosedOrigins', () => {
  it('reports and forgets origins whose tab is no longer open, keeping the open ones', () => {
    const origins = new Map([
      ['s1\nfile:a.ts', 'a.ts'],
      ['s1\nfile:b.ts', 'b.ts']
    ])
    expect(takeClosedOrigins(origins, { s1: tabs('file:b.ts') })).toEqual([{ sessionId: 's1', path: 'a.ts' }])
    expect([...origins.keys()]).toEqual(['s1\nfile:b.ts'])
  })

  it('reports nothing the second time, so a close returns focus once', () => {
    const origins = new Map([['s1\nfile:a.ts', 'a.ts']])
    takeClosedOrigins(origins, { s1: tabs() })
    expect(takeClosedOrigins(origins, { s1: tabs() })).toEqual([])
  })

  it('forgets a deleted Session without reporting it', () => {
    const origins = new Map([['gone\nfile:a.ts', 'a.ts']])
    expect(takeClosedOrigins(origins, {})).toEqual([])
    expect(origins.size).toBe(0)
  })

  it('keeps a tab id that itself contains a newline matched to its Session', () => {
    const origins = new Map([['s1\nfile:odd\nname.ts', 'odd\nname.ts']])
    expect(takeClosedOrigins(origins, { s1: tabs('file:odd\nname.ts') })).toEqual([])
    expect(origins.size).toBe(1)
  })

  it('tells Sessions apart when two have the same tab id', () => {
    const origins = new Map([
      ['s1\nfile:a.ts', 'a.ts'],
      ['s2\nfile:a.ts', 'a.ts']
    ])
    expect(takeClosedOrigins(origins, { s1: tabs('file:a.ts'), s2: tabs() })).toEqual([{ sessionId: 's2', path: 'a.ts' }])
  })
})

describe('shouldReturnFocusToRow', () => {
  it('returns focus when the explorer shows and focus was lost or sits on the tab strip', () => {
    expect(shouldReturnFocusToRow(true, 'body')).toBe(true)
    expect(shouldReturnFocusToRow(true, 'tab-strip')).toBe(true)
  })

  it('leaves focus alone when it sits elsewhere, such as the list after a Ctrl+click open', () => {
    expect(shouldReturnFocusToRow(true, 'other')).toBe(false)
  })

  it('never moves focus while another tab is showing', () => {
    expect(shouldReturnFocusToRow(false, 'body')).toBe(false)
    expect(shouldReturnFocusToRow(false, 'tab-strip')).toBe(false)
  })
})

describe('pollUntilSettled', () => {
  const frames = () => {
    const queue: (() => void)[] = []
    return { queue, nextFrame: (run: () => void) => void queue.push(run) }
  }

  it('keeps trying each frame until the row has mounted, then stops', () => {
    const { queue, nextFrame } = frames()
    let mountedAfter = 3
    const step = vi.fn(() => --mountedAfter <= 0)
    pollUntilSettled(step, nextFrame, 90)
    while (queue.length > 0) queue.shift()?.()
    expect(step).toHaveBeenCalledTimes(3)
  })

  it('gives up when the row never mounts', () => {
    const { queue, nextFrame } = frames()
    const step = vi.fn(() => false)
    pollUntilSettled(step, nextFrame, 4)
    while (queue.length > 0) queue.shift()?.()
    expect(step).toHaveBeenCalledTimes(5)
  })
})

describe('pollUntilSettled give-up', () => {
  it('runs onGiveUp once when the step never settles', () => {
    const queue: (() => void)[] = []
    const onGiveUp = vi.fn()
    pollUntilSettled(() => false, (run) => void queue.push(run), 2, onGiveUp)
    while (queue.length > 0) queue.shift()?.()
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('does not run onGiveUp once the step settles', () => {
    const onGiveUp = vi.fn()
    pollUntilSettled(() => true, () => undefined, 2, onGiveUp)
    expect(onGiveUp).not.toHaveBeenCalled()
  })
})
