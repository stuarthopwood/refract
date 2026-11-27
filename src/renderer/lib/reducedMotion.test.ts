import { afterEach, describe, expect, it, vi } from 'vitest'
import { appReducesMotion, isMotionReduced, osPrefersReducedMotion } from './reducedMotion'

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
})
