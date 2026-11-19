import { describe, expect, it } from 'vitest'
import { keyboardActivation, needsContentFocus, pointerActivation, rowOpenOptions } from './row-open'

const NONE = { ctrlKey: false, metaKey: false }
const click = (modifiers: Partial<typeof NONE> = {}) => pointerActivation({ ...NONE, ...modifiers })

describe('rowOpenOptions', () => {
  it('opens a plain click in the foreground without moving focus', () => {
    expect(rowOpenOptions(click())).toEqual({ background: false, focus: false })
  })

  it('opens Ctrl+click and Cmd+click in the background', () => {
    expect(rowOpenOptions(click({ ctrlKey: true })).background).toBe(true)
    expect(rowOpenOptions(click({ metaKey: true })).background).toBe(true)
  })

  it('moves focus to the new tab for Enter or Space', () => {
    expect(rowOpenOptions(keyboardActivation(NONE))).toEqual({ background: false, focus: true })
  })

  it('keeps list focus for Ctrl+Enter', () => {
    expect(rowOpenOptions(keyboardActivation({ ...NONE, ctrlKey: true }))).toEqual({ background: true, focus: true })
  })
})

describe('needsContentFocus', () => {
  it('focuses an already open tab after keyboard activation, as the shell only focuses a new one', () => {
    expect(needsContentFocus({ background: false, focus: true }, true)).toBe(true)
  })

  it('leaves a new tab to the shell', () => {
    expect(needsContentFocus({ background: false, focus: true }, false)).toBe(false)
  })

  it('never takes focus for a click or a background open', () => {
    expect(needsContentFocus({ background: false, focus: false }, true)).toBe(false)
    expect(needsContentFocus({ background: true, focus: true }, true)).toBe(false)
  })
})
