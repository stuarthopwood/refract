import { describe, expect, it } from 'vitest'
import { containsFocus, focusFollowsReplace, wasReplaced } from './checklist-focus'

const before = { sessionId: 's1', checklistId: 'p1' }
const after = { sessionId: 's1', checklistId: 'p2' }

describe('checklist focus on replace', () => {
  it('replace_moves_focus_when_inside', () => {
    expect(focusFollowsReplace(before, after, true)).toBe(true)
  })

  it('replace_leaves_focus_when_outside', () => {
    expect(focusFollowsReplace(before, after, false)).toBe(false)
  })

  it('same_checklist_never_moves_focus', () => {
    expect(focusFollowsReplace(before, { ...before }, true)).toBe(false)
  })

  it('session_change_is_not_a_replacement', () => {
    expect(wasReplaced(before, { sessionId: 's2', checklistId: 'p9' })).toBe(false)
  })

  it('first_checklist_is_not_a_replacement', () => {
    expect(wasReplaced({ sessionId: 's1', checklistId: null }, after)).toBe(false)
    expect(wasReplaced(before, { sessionId: 's1', checklistId: null })).toBe(false)
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
