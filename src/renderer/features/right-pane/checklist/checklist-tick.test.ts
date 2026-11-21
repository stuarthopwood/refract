import { describe, expect, it } from 'vitest'
import { makeItem } from './checklist-fixtures'
import { needsValueToTick } from './checklist-tick'

describe('needsValueToTick', () => {
  it('is true for a value-required item with no value', () => {
    expect(needsValueToTick(makeItem({ id: 'a', requiresValue: true }))).toBe(true)
  })

  it('is true when the value is an empty string', () => {
    expect(needsValueToTick(makeItem({ id: 'a', requiresValue: true, value: '' }))).toBe(true)
  })

  it('is false once the item has a value', () => {
    expect(needsValueToTick(makeItem({ id: 'a', requiresValue: true, value: 'abc' }))).toBe(false)
  })

  it('is false when no value is required', () => {
    expect(needsValueToTick(makeItem({ id: 'a' }))).toBe(false)
  })

  it('is false for a complete item, so it can still be unticked', () => {
    expect(needsValueToTick(makeItem({ id: 'a', requiresValue: true, status: 'complete' }))).toBe(false)
  })
})
