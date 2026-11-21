import { describe, expect, it } from 'vitest'
import { blurLeavesRegion, containsFocus, shouldRefocus } from './checklist-focus'

describe('shouldRefocus', () => {
  const base = { sameSession: true, focusWasInside: true, focusStillInside: false }

  it('pulls_focus_back_when_the_focused_item_went_away', () => {
    expect(shouldRefocus(base)).toBe(true)
  })

  it('leaves_focus_alone_when_it_was_outside', () => {
    expect(shouldRefocus({ ...base, focusWasInside: false })).toBe(false)
  })

  it('leaves_focus_alone_when_it_is_still_inside', () => {
    expect(shouldRefocus({ ...base, focusStillInside: true })).toBe(false)
  })

  it('a_session_change_never_pulls_focus', () => {
    expect(shouldRefocus({ ...base, sameSession: false })).toBe(false)
  })
})

describe('blurLeavesRegion', () => {
  const inner = {} as Node
  const region = { contains: (node: Node | null) => node === inner }
  const mounted = { isConnected: true }

  it('moving_focus_within_the_region_is_not_leaving', () => {
    expect(blurLeavesRegion(region, inner, mounted)).toBe(false)
  })

  it('moving_focus_elsewhere_or_to_nothing_is_leaving', () => {
    expect(blurLeavesRegion(region, {} as Node, mounted)).toBe(true)
    expect(blurLeavesRegion(region, null, mounted)).toBe(true)
  })

  it('an_unmounted_element_is_not_a_departure', () => {
    expect(blurLeavesRegion(region, null, { isConnected: false })).toBe(false)
  })
})

describe('containsFocus', () => {
  const inner = {} as Node
  const region = { contains: (node: Node | null) => node === inner }

  it('is_true_only_for_a_node_inside_the_region', () => {
    expect(containsFocus(region, inner)).toBe(true)
    expect(containsFocus(region, {} as Node)).toBe(false)
  })

  it('is_false_without_a_region_or_active_element', () => {
    expect(containsFocus(null, inner)).toBe(false)
    expect(containsFocus(region, null)).toBe(false)
  })
})
