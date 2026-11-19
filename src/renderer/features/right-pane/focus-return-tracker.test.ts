import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DOCUMENTS, useDocumentTabsStore } from '@/state/document-tabs-store'
import { createOriginTracker, focusLocation, pollUntilSettled, shouldReturnFocusToRow, takeClosedOrigins } from './focus-return-tracker'

const tabs = (...ids: string[]) => ({ tabs: ids.map((id) => ({ id })) })

describe('takeClosedOrigins', () => {
  it('reports and forgets origins whose tab is no longer open, keeping the open ones', () => {
    const origins = new Map([
      ['s1\nfile:a.ts', 'a.ts'],
      ['s1\nfile:b.ts', 'b.ts']
    ])
    expect(takeClosedOrigins(origins, { s1: tabs('file:b.ts') })).toEqual([{ sessionId: 's1', value: 'a.ts' }])
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
    expect(takeClosedOrigins(origins, { s1: tabs('file:a.ts'), s2: tabs() })).toEqual([{ sessionId: 's2', value: 'a.ts' }])
  })
})

describe('shouldReturnFocusToRow', () => {
  it('returns focus when the panel shows and focus was lost or sits on the tab strip', () => {
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

describe('focusLocation', () => {
  const body = {}
  const within = (selector: string) => ({ closest: (query: string) => (query.includes(selector) ? {} : null) })

  it('reads no focused element, or the body, as lost focus', () => {
    expect(focusLocation(null, body)).toBe('body')
    expect(focusLocation(body as never, body)).toBe('body')
  })

  it('counts an element inside a tablist as the tab strip', () => {
    expect(focusLocation(within('[role="tablist"]'), body)).toBe('tab-strip')
  })

  it('counts the single-item header close button as the tab strip', () => {
    expect(focusLocation(within('[data-panel-close]'), body)).toBe('tab-strip')
  })

  it('counts anything else as another place focus is deliberately sitting', () => {
    expect(focusLocation({ closest: () => null }, body)).toBe('other')
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

describe('createOriginTracker', () => {
  const frames: (() => void)[] = []
  const flush = () => {
    while (frames.length > 0) frames.shift()?.()
  }
  const body = {}
  let active: unknown = body
  let showing = true
  const focusTarget = vi.fn((_sessionId: string, _value: string) => true)
  const focusFallback = vi.fn()
  const tracker = createOriginTracker({ isShowing: () => showing, focusTarget, focusFallback })
  const open = (...ids: string[]) =>
    useDocumentTabsStore.setState({
      bySession: { s1: { ...EMPTY_SESSION_DOCUMENTS, tabs: ids.map((id) => ({ id, dead: false, kind: 'file' as const, path: id })) } }
    })

  beforeEach(() => {
    frames.length = 0
    active = body
    showing = true
    focusTarget.mockReset().mockReturnValue(true)
    focusFallback.mockReset()
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run))
    vi.stubGlobal('document', {
      body,
      get activeElement() {
        return active
      }
    })
    tracker.reset()
    open()
  })

  afterEach(() => {
    tracker.reset()
    vi.unstubAllGlobals()
  })

  it('returns focus to the row once its tab closes', () => {
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    open()
    flush()
    expect(focusTarget).toHaveBeenCalledExactlyOnceWith('s1', 'row-a')
  })

  it('does nothing while its tab stays open', () => {
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    open('a', 'b')
    flush()
    expect(focusTarget).not.toHaveBeenCalled()
  })

  it('keeps the origin and returns no focus on a store update that leaves the tabs untouched', () => {
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    useDocumentTabsStore.setState({})
    flush()
    expect(focusTarget).not.toHaveBeenCalled()
    expect(tracker.origins.size).toBe(1)
  })

  it('returns focus to the first closed origin only when several tabs close together', () => {
    open('a', 'b')
    tracker.remember('s1', 'a', 'row-a')
    tracker.remember('s1', 'b', 'row-b')
    open()
    flush()
    expect(focusTarget).toHaveBeenCalledExactlyOnceWith('s1', 'row-a')
  })

  it('cancels a running poll when a newer close starts', () => {
    focusTarget.mockReturnValue(false)
    open('a', 'b')
    tracker.remember('s1', 'a', 'row-a')
    tracker.remember('s1', 'b', 'row-b')
    open('b')
    for (let frame = 0; frame < 2; frame++) frames.splice(0).forEach((run) => run())
    expect(focusTarget).toHaveBeenCalledWith('s1', 'row-a')
    focusTarget.mockClear()
    open()
    flush()
    expect(focusTarget).toHaveBeenCalled()
    expect(focusTarget.mock.calls.every(([, value]) => value === 'row-b')).toBe(true)
  })

  it('leaves focus alone when it sits somewhere else', () => {
    active = { closest: () => null }
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    open()
    flush()
    expect(focusTarget).not.toHaveBeenCalled()
  })

  it('polls 90 frames for the row, then runs the fallback once', () => {
    focusTarget.mockReturnValue(false)
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    open()
    flush()
    expect(focusTarget).toHaveBeenCalledTimes(91)
    expect(focusFallback).toHaveBeenCalledExactlyOnceWith('s1', 'row-a')
  })

  it('skips the fallback when another tab is showing at the end of the poll', () => {
    focusTarget.mockReturnValue(false)
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    open()
    showing = false
    flush()
    expect(focusFallback).not.toHaveBeenCalled()
  })

  it('stops listening and forgets origins on reset', () => {
    open('a')
    tracker.remember('s1', 'a', 'row-a')
    tracker.reset()
    open()
    flush()
    expect(tracker.origins.size).toBe(0)
    expect(focusTarget).not.toHaveBeenCalled()
  })
})
