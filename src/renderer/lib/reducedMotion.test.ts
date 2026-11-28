import { afterEach, describe, expect, it, vi } from 'vitest'
import { appReducesMotion, isMotionReduced, osPrefersReducedMotion, subscribeOsReducedMotion } from './reducedMotion'

function stub(os: boolean, app: 'on' | undefined) {
  vi.stubGlobal('matchMedia', () => ({ matches: os }))
  vi.stubGlobal('document', { documentElement: { dataset: app ? { reduceMotion: app } : {} } })
}

describe('reducedMotion', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is off when neither the OS nor the Reduce motion switch asks for it', () => {
    stub(false, undefined)
    expect(isMotionReduced()).toBe(false)
  })

  it('follows the OS setting when the Reduce motion switch is off', () => {
    stub(true, undefined)
    expect(osPrefersReducedMotion()).toBe(true)
    expect(appReducesMotion()).toBe(false)
    expect(isMotionReduced()).toBe(true)
  })

  it('is on when the Reduce motion switch is on, whatever the OS says', () => {
    stub(false, 'on')
    expect(appReducesMotion()).toBe(true)
    expect(isMotionReduced()).toBe(true)
  })

  it('does not throw where there is no matchMedia or document', () => {
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('document', undefined)
    expect(isMotionReduced()).toBe(false)
  })

  it('still follows the OS setting where there is no document', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    vi.stubGlobal('document', undefined)
    expect(appReducesMotion()).toBe(false)
    expect(isMotionReduced()).toBe(true)
  })

  it('reports each change of the OS setting until unsubscribed', () => {
    let listener: (event: { matches: boolean }) => void = () => undefined
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: (_type: string, fn: typeof listener) => (listener = fn),
      removeEventListener
    }))
    const seen: boolean[] = []
    const stop = subscribeOsReducedMotion((reduced) => seen.push(reduced))
    listener({ matches: true })
    listener({ matches: false })
    expect(seen).toEqual([true, false])
    stop()
    expect(removeEventListener).toHaveBeenCalledWith('change', listener)
  })

  it('subscribes to nothing where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => subscribeOsReducedMotion(() => undefined)()).not.toThrow()
  })
})
