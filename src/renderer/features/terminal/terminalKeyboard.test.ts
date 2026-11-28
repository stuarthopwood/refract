import { describe, expect, it, vi } from 'vitest'
import { focusStranded, opensContextMenu, returnFocus } from './terminalKeyboard'
import { panelDomId, renameOutcome, tabDomId } from './terminalTabs'

// The renderer tests run in node with no DOM, so the keyboard rules are pinned as pure functions.

const key = (name: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods
})

describe('keyboard hand-offs', () => {
  it('opens_the_context_menu_on_the_menu_key_and_shift_f10_only', () => {
    expect(opensContextMenu(key('ContextMenu'))).toBe(true)
    expect(opensContextMenu(key('F10', { shiftKey: true }))).toBe(true)
    expect(opensContextMenu(key('F10'))).toBe(false)
    expect(opensContextMenu(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(opensContextMenu(key('a', { shiftKey: true }))).toBe(false)
  })

  it('sees_focus_as_stranded_on_the_body_or_nowhere', () => {
    const body = {}
    expect(focusStranded({ activeElement: body, body })).toBe(true)
    expect(focusStranded({ activeElement: null, body })).toBe(true)
    expect(focusStranded({ activeElement: {}, body })).toBe(false)
  })

  it('gives_focus_to_the_terminal_and_falls_back_only_when_none_is_mounted', () => {
    const fallback = vi.fn()
    returnFocus(() => true, fallback)
    expect(fallback).not.toHaveBeenCalled()
    returnFocus(() => false, fallback)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('rename and tab ids', () => {
  it('returns_focus_to_the_tab_after_enter_or_escape_but_not_after_a_blur', () => {
    expect(renameOutcome('build', 'Terminal 1', 'enter')).toEqual({ name: 'build', refocusTab: true })
    expect(renameOutcome('build', 'Terminal 1', 'escape')).toEqual({ name: null, refocusTab: true })
    expect(renameOutcome('build', 'Terminal 1', 'blur')).toEqual({ name: 'build', refocusTab: false })
  })

  it('ties_each_tab_to_a_distinct_panel_id', () => {
    expect(tabDomId('a')).not.toBe(panelDomId('a'))
    expect(tabDomId('a')).not.toBe(tabDomId('b'))
  })
})
