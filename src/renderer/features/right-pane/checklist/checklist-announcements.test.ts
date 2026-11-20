import { describe, expect, it } from 'vitest'
import { makeChecklist, makeItem } from './checklist-fixtures'
import { describeAgentChange, openedAnnouncement, REPLACED_ANNOUNCEMENT } from './checklist-announcements'

describe('openedAnnouncement', () => {
  it('names_title_and_count_with_plural', () => {
    const checklist = makeChecklist({ title: 'Plan', items: [makeItem({ id: 'a' }), makeItem({ id: 'b' })] })
    expect(openedAnnouncement(checklist)).toBe('Checklist opened: Plan, 2 items')
  })

  it('uses_singular_for_one_item', () => {
    expect(openedAnnouncement(makeChecklist({ title: 'Plan' }))).toBe('Checklist opened: Plan, 1 item')
  })

  it('replaced_line_is_stable', () => {
    expect(REPLACED_ANNOUNCEMENT).toBe('Checklist replaced')
  })
})

describe('describeAgentChange', () => {
  const base = makeChecklist({ items: [makeItem({ id: 'a', text: 'Write' }), makeItem({ id: 'b', text: 'Ship' })] })

  it('returns_null_when_nothing_user_visible_changed', () => {
    expect(describeAgentChange(base, makeChecklist({ rev: 2, items: base.items }))).toBeNull()
  })

  it('reports_a_status_change_with_the_status_word', () => {
    const next = makeChecklist({ rev: 2, items: [makeItem({ id: 'a', text: 'Write', status: 'complete' }), makeItem({ id: 'b', text: 'Ship' })] })
    expect(describeAgentChange(base, next)).toBe('Write is now complete')
  })

  it('reports_added_and_removed_items', () => {
    const next = makeChecklist({ rev: 2, items: [makeItem({ id: 'a', text: 'Write' }), makeItem({ id: 'c', text: 'Test' })] })
    expect(describeAgentChange(base, next)).toBe('Item added: Test. Item removed: Ship')
  })

  it('summarises_more_than_three_changes', () => {
    const next = makeChecklist({
      rev: 2,
      items: ['w', 'x', 'y', 'z'].map((id) => makeItem({ id, text: id }))
    })
    expect(describeAgentChange(base, next)).toBe('6 items changed')
  })
})
