import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMotionReduced } from '@/lib/reducedMotion'
import { exitDelayMs } from './fadeCollapseExit'

function stub(os: boolean, app: 'on' | undefined) {
  vi.stubGlobal('matchMedia', () => ({ matches: os }))
  vi.stubGlobal('document', { documentElement: { dataset: app ? { reduceMotion: app } : {} } })
}

describe('FadeCollapse exit delay', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('unmounts_at_once_when_only_the_reduce_motion_switch_is_on', () => {
    stub(false, 'on')
    expect(exitDelayMs(isMotionReduced())).toBe(0)
  })

  it('unmounts_at_once_when_only_the_os_asks_for_reduced_motion', () => {
    stub(true, undefined)
    expect(exitDelayMs(isMotionReduced())).toBe(0)
  })

  it('keeps_the_fade_when_neither_asks_for_reduced_motion', () => {
    stub(false, undefined)
    expect(exitDelayMs(isMotionReduced())).toBe(200)
  })
})
