import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatchRefs } from './watch-refs'

const ensure = vi.fn(() => Promise.resolve({ ok: true }))
const stop = vi.fn(() => Promise.resolve({ ok: true }))
const onLastRelease = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  ensure.mockClear()
  stop.mockClear()
  onLastRelease.mockClear()
})

afterEach(() => vi.useRealTimers())

describe('createWatchRefs', () => {
  it('starts the watcher once however many views hold the Session', () => {
    const refs = createWatchRefs('t', ensure, stop)
    refs.acquire('s1')
    refs.acquire('s1')
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('keeps the watcher running until the last holder leaves', () => {
    const refs = createWatchRefs('t', ensure, stop, onLastRelease)
    refs.acquire('s1')
    refs.acquire('s1')
    refs.release('s1')
    vi.runAllTimers()
    expect(stop).not.toHaveBeenCalled()
    refs.release('s1')
    vi.runAllTimers()
    expect(stop).toHaveBeenCalledWith('s1')
    expect(onLastRelease).toHaveBeenCalledWith('s1')
  })

  it('does not stop or restart the watcher when a view acquires straight after the last release', () => {
    const refs = createWatchRefs('t', ensure, stop, onLastRelease)
    refs.acquire('s1')
    refs.release('s1')
    refs.acquire('s1')
    vi.runAllTimers()
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    expect(onLastRelease).not.toHaveBeenCalled()
  })

  it('still stops once the swapped-in view leaves', () => {
    const refs = createWatchRefs('t', ensure, stop)
    refs.acquire('s1')
    refs.release('s1')
    refs.acquire('s1')
    refs.release('s1')
    vi.runAllTimers()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('counts each Session on its own', () => {
    const refs = createWatchRefs('t', ensure, stop)
    refs.acquire('s1')
    refs.acquire('s2')
    refs.release('s1')
    vi.runAllTimers()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith('s1')
  })

  it('starts again after a full release has stopped the watcher', () => {
    const refs = createWatchRefs('t', ensure, stop)
    refs.acquire('s1')
    refs.release('s1')
    vi.runAllTimers()
    refs.acquire('s1')
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('restarts without changing the count', () => {
    const refs = createWatchRefs('t', ensure, stop)
    refs.acquire('s1')
    refs.restart('s1')
    refs.release('s1')
    vi.runAllTimers()
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('warns instead of throwing when the start call fails or rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refs = createWatchRefs('t', () => Promise.resolve({ ok: false, error: 'x' }), () => Promise.reject(new Error('y')))
    refs.acquire('s1')
    refs.release('s1')
    vi.runAllTimers()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
