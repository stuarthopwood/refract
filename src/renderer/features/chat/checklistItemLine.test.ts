import { describe, expect, it } from 'vitest'
import { makeChecklist, makeItem } from '../right-pane/checklist/checklist-fixtures'
import { resolveChecklistItemLine } from './checklistItemLine'

const checklist = makeChecklist({ id: 'p1', items: [makeItem({ id: 'i1', text: 'First' }), makeItem({ id: 'i2', text: 'Second' }), makeItem({ id: 'i3', text: 'Third' })] })
const loaded = { checklist, loaded: true, error: null }

describe('resolveChecklistItemLine', () => {
  it('finds_one_based_position', () => {
    expect(resolveChecklistItemLine(loaded, 'p1', 'i1')).toEqual({ kind: 'item', position: 1, text: 'First' })
    expect(resolveChecklistItemLine(loaded, 'p1', 'i3')).toEqual({ kind: 'item', position: 3, text: 'Third' })
  })

  it('removed_when_item_absent_in_same_checklist', () => {
    expect(resolveChecklistItemLine(loaded, 'p1', 'i9')).toEqual({ kind: 'removed' })
  })

  it('removed_when_no_checklist_is_active_after_a_clean_load', () => {
    expect(resolveChecklistItemLine({ checklist: null, loaded: true, error: null }, 'p1', 'i1')).toEqual({ kind: 'removed' })
  })

  it('replaced_when_active_id_differs', () => {
    expect(resolveChecklistItemLine(loaded, 'p0', 'i1')).toEqual({ kind: 'replaced' })
  })

  it('unknown_when_not_loaded', () => {
    expect(resolveChecklistItemLine({ checklist: null, loaded: false, error: null }, 'p1', 'i1')).toEqual({ kind: 'unknown' })
  })

  it('unknown_when_the_read_failed_and_nothing_is_held', () => {
    expect(resolveChecklistItemLine({ checklist: null, loaded: true, error: 'boom' }, 'p1', 'i1')).toEqual({ kind: 'unknown' })
  })
})
