import { describe, expect, it } from 'vitest'
import { createScrollMemory } from './scroll-memory'

describe('createScrollMemory', () => {
  it('restores the saved position once the content is ready, and only once', () => {
    const memory = createScrollMemory(120)
    expect(memory.restore(false, true)).toBeNull()
    expect(memory.restore(true, true)).toBe(120)
    expect(memory.restore(true, true)).toBeNull()
  })

  it('waits for the scroller to exist before it counts as restored', () => {
    const memory = createScrollMemory(40)
    expect(memory.restore(true, false)).toBeNull()
    expect(memory.restore(true, true)).toBe(40)
  })

  it('restores to the top when nothing was saved', () => {
    expect(createScrollMemory(undefined).restore(true, true)).toBe(0)
  })

  it('ignores scroll events before the restore, so the browser starting at the top does not overwrite the saved position', () => {
    const memory = createScrollMemory(120)
    memory.track(0)
    expect(memory.last()).toBe(120)
  })

  it('tracks the last position after the restore, for the unmount save', () => {
    const memory = createScrollMemory(120)
    memory.restore(true, true)
    memory.track(300)
    memory.track(275)
    expect(memory.last()).toBe(275)
  })
})
