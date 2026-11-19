import { describe, expect, it } from 'vitest'
import { scrollLeftToReveal } from './tab-strip-scroll'

describe('scrollLeftToReveal', () => {
  const view = { scrollLeft: 100, viewWidth: 200 }

  it('leaves the scroll alone for a tab already in view', () => {
    expect(scrollLeftToReveal(view, { start: 150, width: 80 })).toBe(100)
  })

  it('scrolls left just far enough to show a tab cut off at the start', () => {
    expect(scrollLeftToReveal(view, { start: 60, width: 80 })).toBe(60)
  })

  it('scrolls right just far enough to show a tab cut off at the end', () => {
    expect(scrollLeftToReveal(view, { start: 260, width: 80 })).toBe(140)
  })

  it('lines a tab wider than the view up at its start', () => {
    expect(scrollLeftToReveal(view, { start: 120, width: 240 })).toBe(120)
  })

  it('treats a tab flush with an edge as visible', () => {
    expect(scrollLeftToReveal(view, { start: 100, width: 80 })).toBe(100)
    expect(scrollLeftToReveal(view, { start: 220, width: 80 })).toBe(100)
  })

  it('leaves a view with no width where it is, since nothing can be revealed in it', () => {
    expect(scrollLeftToReveal({ scrollLeft: 0, viewWidth: 0 }, { start: 80, width: 136 })).toBe(0)
    expect(scrollLeftToReveal({ scrollLeft: 40, viewWidth: 0 }, { start: 10, width: 136 })).toBe(40)
  })

  it('reveals a panel tab in the pinned group the same way as a document tab', () => {
    expect(scrollLeftToReveal({ scrollLeft: 0, viewWidth: 83 }, { start: 168, width: 56 })).toBe(141)
    expect(scrollLeftToReveal({ scrollLeft: 141, viewWidth: 83 }, { start: 0, width: 56 })).toBe(0)
  })
})
