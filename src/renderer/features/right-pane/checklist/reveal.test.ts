import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { flashRowHighlight } from '@/features/chat-nav/highlightRow'
import { findRevealRow, judgeReveal, runReveal, scrollTopToShow, type RevealRow, type RevealView } from './reveal'

vi.mock('@/features/chat-nav/highlightRow', () => ({ flashRowHighlight: vi.fn() }))

const request = { sessionId: 's1', checklistId: 'c1', itemId: 'i3' }
const view: RevealView = { sessionId: 's1', checklistId: 'c1', loaded: true }

function setup(row: RevealRow | null, scrollTop = 0) {
  const scroller = { scrollTop, clientHeight: 100 }
  const calls: string[] = []
  const find = vi.fn((itemId: string) => (itemId === 'i3' ? row : null))
  const clear = vi.fn(() => calls.push('clear'))
  const makeRow = (top: number): RevealRow => ({
    top,
    height: 20,
    focusTick: () => calls.push('focus'),
    flash: () => calls.push('flash')
  })
  return { scroller, calls, find, clear, makeRow }
}

beforeEach(() => vi.mocked(flashRowHighlight).mockClear())

describe('runReveal', () => {
  it('reveal_scrolls_flashes_and_clears', () => {
    const t = setup(null)
    const row = t.makeRow(300)
    runReveal({ request, view, scroller: t.scroller, findRow: () => row, clear: t.clear })
    expect(t.scroller.scrollTop).toBe(220)
    expect(t.calls).toEqual(['focus', 'flash', 'clear'])
  })

  it('reveal_for_other_session_ignored', () => {
    const t = setup(null)
    runReveal({ request, view: { ...view, sessionId: 's2' }, scroller: t.scroller, findRow: t.find, clear: t.clear })
    expect(t.find).not.toHaveBeenCalled()
    expect(t.clear).not.toHaveBeenCalled()
    expect(t.scroller.scrollTop).toBe(0)
  })

  it('reveal_unknown_item_cleared_without_effect', () => {
    const t = setup(null)
    runReveal({ request: { ...request, itemId: 'gone' }, view, scroller: t.scroller, findRow: t.find, clear: t.clear })
    expect(t.scroller.scrollTop).toBe(0)
    expect(t.calls).toEqual(['clear'])
  })

  it('reveal_unknown_checklist_cleared_without_effect', () => {
    const t = setup(null)
    const row = t.makeRow(300)
    runReveal({ request: { ...request, checklistId: 'other' }, view, scroller: t.scroller, findRow: () => row, clear: t.clear })
    expect(t.scroller.scrollTop).toBe(0)
    expect(t.calls).toEqual(['clear'])
  })

  it('reveal_waits_for_the_first_load', () => {
    const t = setup(null)
    runReveal({ request, view: { sessionId: 's1', checklistId: null, loaded: false }, scroller: t.scroller, findRow: t.find, clear: t.clear })
    expect(t.clear).not.toHaveBeenCalled()
    runReveal({ request, view: { sessionId: 's1', checklistId: null, loaded: true }, scroller: t.scroller, findRow: t.find, clear: t.clear })
    expect(t.calls).toEqual(['clear'])
  })
})

describe('judgeReveal', () => {
  it('judges_each_case', () => {
    expect(judgeReveal(request, view)).toBe('reveal')
    expect(judgeReveal(request, { ...view, sessionId: 's2' })).toBe('wait')
    expect(judgeReveal(request, { ...view, checklistId: 'c2' })).toBe('drop')
    expect(judgeReveal(request, { ...view, checklistId: null, loaded: false })).toBe('wait')
    expect(judgeReveal(request, { ...view, checklistId: null })).toBe('drop')
  })
})

describe('scrollTopToShow', () => {
  const scroller = { scrollTop: 50, clientHeight: 100 }
  it('scrolls_up_to_a_row_above_the_view', () => {
    expect(scrollTopToShow(scroller, { top: 10, height: 20 })).toBe(10)
  })
  it('scrolls_down_to_a_row_below_the_view', () => {
    expect(scrollTopToShow(scroller, { top: 200, height: 20 })).toBe(120)
  })
  it('leaves_a_visible_row_alone', () => {
    expect(scrollTopToShow(scroller, { top: 60, height: 20 })).toBe(50)
  })
})

describe('findRevealRow', () => {
  interface FakeElement {
    dataset: { checklistItem: string }
    getBoundingClientRect: () => { top: number; height: number }
    querySelector: Mock
    tick: { focus: Mock }
  }
  function fakeElement(id: string, top: number): FakeElement {
    const tick = { focus: vi.fn() }
    return {
      dataset: { checklistItem: id },
      getBoundingClientRect: () => ({ top, height: 24 }),
      querySelector: vi.fn(() => tick),
      tick
    }
  }
  const scrollerOf = (elements: FakeElement[]) => ({
    scrollTop: 40,
    clientHeight: 100,
    getBoundingClientRect: () => ({ top: 10 }),
    querySelectorAll: () => elements as unknown as HTMLElement[]
  })

  it('measures_the_row_in_content_coordinates_and_acts_on_it', () => {
    const a = fakeElement('i1', 30)
    const b = fakeElement('i3', 90)
    const row = findRevealRow(scrollerOf([a, b]), 'i3')
    expect(row).toMatchObject({ top: 120, height: 24 })
    row?.focusTick()
    expect(b.querySelector).toHaveBeenCalledWith("[data-slot='checkbox-item']")
    expect(b.tick.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(a.tick.focus).not.toHaveBeenCalled()
    row?.flash()
    expect(flashRowHighlight).toHaveBeenCalledWith(b)
  })

  it('returns_null_for_an_unknown_item', () => {
    expect(findRevealRow(scrollerOf([fakeElement('i1', 30)]), 'i3')).toBeNull()
  })
})
