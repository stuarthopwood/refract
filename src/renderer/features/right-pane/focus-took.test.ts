import { describe, expect, it, vi } from 'vitest'
import { focusTook } from './focus-took'

const fakeElement = (takesFocus: boolean) => {
  const doc = { activeElement: null as unknown }
  const el = { ownerDocument: doc, focus: vi.fn(() => void (takesFocus && (doc.activeElement = el))) }
  return el as unknown as HTMLElement
}

describe('focusTook', () => {
  it('reports true when the element became the active element', () => {
    expect(focusTook(fakeElement(true))).toBe(true)
  })

  it('reports false when focus() was ignored, so the caller can retry on the next frame', () => {
    const el = fakeElement(false)
    expect(focusTook(el)).toBe(false)
    expect(el.focus).toHaveBeenCalledTimes(1)
  })
})
