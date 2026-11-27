import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMotionReduced } from '@/lib/reducedMotion'
import { flightsSuppressed } from './flightGuard'

function stub(os: boolean, app: 'on' | undefined) {
  vi.stubGlobal('matchMedia', () => ({ matches: os }))
  vi.stubGlobal('document', { documentElement: { dataset: app ? { reduceMotion: app } : {} } })
}

describe('holiday flight guard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('schedules_no_flight_when_the_reduce_motion_switch_is_on_and_the_os_is_off', () => {
    stub(false, 'on')
    expect(flightsSuppressed(isMotionReduced(), false)).toBe(true)
  })

  it('schedules_no_flight_under_forced_colours_or_reduced_transparency', () => {
    stub(false, undefined)
    expect(flightsSuppressed(isMotionReduced(), true)).toBe(true)
  })

  it('allows_flights_when_nothing_suppresses_them', () => {
    stub(false, undefined)
    expect(flightsSuppressed(isMotionReduced(), false)).toBe(false)
  })
})
