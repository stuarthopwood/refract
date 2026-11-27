import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDevicePixelRatio, subscribeDevicePixelRatio } from './useDevicePixelRatio'

type Listener = () => void

function stubScreen(initialRatio: number) {
  const queries: { media: string; listeners: Set<Listener> }[] = []
  const screen = {
    devicePixelRatio: initialRatio,
    matchMedia: (media: string) => {
      const entry = { media, listeners: new Set<Listener>() }
      queries.push(entry)
      return {
        addEventListener: (_type: string, listener: Listener) => entry.listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => entry.listeners.delete(listener)
      }
    }
  }
  vi.stubGlobal('window', screen)
  return { screen, queries }
}

afterEach(() => vi.unstubAllGlobals())

describe('readDevicePixelRatio', () => {
  it('reads the live ratio and treats a missing one as 1', () => {
    expect(readDevicePixelRatio()).toBe(1)
    stubScreen(1.5)
    expect(readDevicePixelRatio()).toBe(1.5)
  })
})

function queryAt<T>(queries: T[], index: number): T {
  const query = queries[index]
  if (!query) throw new Error(`no media query at ${index}`)
  return query
}

describe('subscribeDevicePixelRatio', () => {
  it('notifies when the ratio changes and re-arms the query for the new ratio', () => {
    const { screen, queries } = stubScreen(1.25)
    const notify = vi.fn()
    subscribeDevicePixelRatio(notify)
    expect(queries.map((query) => query.media)).toEqual(['(resolution: 1.25dppx)'])

    screen.devicePixelRatio = 2
    for (const listener of queryAt(queries, 0).listeners) listener()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(queries.map((query) => query.media)).toEqual(['(resolution: 1.25dppx)', '(resolution: 2dppx)'])
    expect(queryAt(queries, 0).listeners.size).toBe(0)
    expect(queryAt(queries, 1).listeners.size).toBe(1)
  })

  it('stops listening on unsubscribe', () => {
    const { queries } = stubScreen(1)
    subscribeDevicePixelRatio(vi.fn())()
    expect(queryAt(queries, 0).listeners.size).toBe(0)
  })
})
