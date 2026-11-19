import { describe, expect, it } from 'vitest'
import { isGenuineOpen, openFocusTarget, shellLayout } from './shell-tabs'

const before = (sessionId: string | null, ...keys: string[]) => ({ sessionId, keys: new Set(keys) })

describe('shellLayout', () => {
  it('shows the launcher for none, a title row for a lone tab and the tab bar from two', () => {
    expect([0, 1, 2, 5].map(shellLayout)).toEqual(['launcher', 'title-row', 'tab-bar', 'tab-bar'])
  })
})

describe('isGenuineOpen', () => {
  it('is true for a panel tab that was not in the strip before', () => {
    expect(isGenuineOpen(before('s1', 'panel:outline'), 's1', 'panel:git-changes')).toBe(true)
  })

  it('is true for a document tab that was not in the strip before', () => {
    expect(isGenuineOpen(before('s1', 'panel:outline'), 's1', 'file:a.ts')).toBe(true)
  })

  it('is true for the lone tab opened from the launcher', () => {
    expect(isGenuineOpen(before('s1'), 's1', 'file:a.ts')).toBe(true)
  })

  it('is false when the active tab was already open, so a plain tab switch keeps focus', () => {
    expect(isGenuineOpen(before('s1', 'panel:outline', 'file:a.ts'), 's1', 'file:a.ts')).toBe(false)
  })

  it('is false when a Session switch swaps in document tabs the strip did not hold', () => {
    expect(isGenuineOpen(before('s1', 'panel:outline'), 's2', 'file:a.ts')).toBe(false)
  })

  it('is false with no active tab', () => {
    expect(isGenuineOpen(before('s1'), 's1', null)).toBe(false)
  })
})

describe('openFocusTarget', () => {
  it('focuses the tab for a keyboard-opened document tab in the strip', () => {
    expect(openFocusTarget(true, false, 'document', 'tab-bar')).toBe('tab')
  })

  it('keeps content focus for a panel open', () => {
    expect(openFocusTarget(true, false, 'panel', 'tab-bar')).toBe('content')
  })

  it('falls back to content for a lone document tab, which has no strip button', () => {
    expect(openFocusTarget(true, false, 'document', 'title-row')).toBe('content')
  })

  it('moves nothing for a background, pointer or agent open', () => {
    expect(openFocusTarget(true, true, 'document', 'tab-bar')).toBe('none')
  })

  it('moves nothing when no tab was opened', () => {
    expect(openFocusTarget(false, false, 'document', 'tab-bar')).toBe('none')
  })
})
