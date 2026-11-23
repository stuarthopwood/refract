import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASK_OPTION_ATTRIBUTE, focusedOptionIndex, isNoteShortcut, pickBeforeNote } from './askChoiceKeys'

function press(key: string, extra: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean; target?: unknown } = {}) {
  return {
    key,
    ctrlKey: extra.ctrlKey ?? false,
    altKey: extra.altKey ?? false,
    metaKey: extra.metaKey ?? false,
    repeat: extra.repeat ?? false,
    defaultPrevented: extra.defaultPrevented ?? false,
    nativeEvent: { isComposing: extra.isComposing ?? false },
    target: (extra.target ?? { tagName: 'BUTTON' }) as EventTarget
  }
}

describe('isNoteShortcut (#1987)', () => {
  it.each(['n', 'N'])('accepts a bare %s on a button or row', (key) => {
    expect(isNoteShortcut(press(key))).toBe(true)
  })

  it.each([
    ['another key', press('m')],
    ['Ctrl+N', press('n', { ctrlKey: true })],
    ['Alt+N', press('n', { altKey: true })],
    ['Meta+N', press('n', { metaKey: true })],
    ['a held N', press('n', { repeat: true })],
    ['N during IME composition', press('n', { isComposing: true })],
    ['an already handled N', press('n', { defaultPrevented: true })],
    ['N typed in an input', press('n', { target: { tagName: 'INPUT' } })],
    ['N typed in a textarea', press('n', { target: { tagName: 'TEXTAREA' } })],
    ['N typed in a contentEditable', press('n', { target: { tagName: 'DIV', isContentEditable: true } })]
  ])('ignores %s', (_name, event) => {
    expect(isNoteShortcut(event)).toBe(false)
  })
})

describe('pickBeforeNote (#1987)', () => {
  it.each([
    ['single-choice, not picked', false, false, 'select'],
    ['multi-select, not picked', true, false, 'toggle'],
    ['single-choice, already picked', false, true, null],
    ['multi-select, already ticked', true, true, null]
  ] as const)('%s', (_name, multi, picked, expected) => {
    expect(pickBeforeNote(multi, picked)).toBe(expected)
  })
})

describe('focusedOptionIndex (#1987)', () => {
  // The repo has no jsdom: a tiny stand-in for Element, as `closest` and `querySelectorAll` are all the helper uses.
  class FakeElement {
    constructor(private readonly owner: FakeElement | null = null) {}
    closest(): FakeElement | null {
      return this.owner
    }
  }
  afterEach(() => vi.unstubAllGlobals())

  function setup() {
    vi.stubGlobal('Element', FakeElement)
    const first = new FakeElement()
    const second = new FakeElement()
    const container = { querySelectorAll: (selector: string) => (selector === `[${ASK_OPTION_ATTRIBUTE}]` ? [first, second] : []) }
    return { first, second, container: container as unknown as ParentNode }
  }

  it('returns the position of the option wrapper a focused control sits in', () => {
    const { first, second, container } = setup()
    expect(focusedOptionIndex(container, new FakeElement(first) as unknown as EventTarget)).toBe(0)
    expect(focusedOptionIndex(container, new FakeElement(second) as unknown as EventTarget)).toBe(1)
  })

  it('returns null for a control outside every option, a missing target or a missing container', () => {
    const { first, container } = setup()
    expect(focusedOptionIndex(container, new FakeElement(null) as unknown as EventTarget)).toBeNull()
    expect(focusedOptionIndex(container, null)).toBeNull()
    expect(focusedOptionIndex(null, new FakeElement(first) as unknown as EventTarget)).toBeNull()
  })
})
