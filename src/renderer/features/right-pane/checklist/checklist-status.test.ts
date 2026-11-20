import { describe, expect, it } from 'vitest'
import { ITEM_STATUSES } from '../../../../shared/checklist'
import { STATUS_GLYPH } from '../../chat/statusGlyph'
import { CHECKLIST_STATUS_GLYPH } from './checklist-status'

describe('CHECKLIST_STATUS_GLYPH', () => {
  it('has_entry_for_every_item_status', () => {
    expect(Object.keys(CHECKLIST_STATUS_GLYPH).sort()).toEqual([...ITEM_STATUSES].sort())
  })

  it('visible_word_only_for_next_in_progress_blocked', () => {
    const visible = ITEM_STATUSES.filter((status) => CHECKLIST_STATUS_GLYPH[status].showWord)
    expect(visible).toEqual(['next', 'in_progress', 'blocked'])
  })

  it('complete_reuses_success_done_glyph', () => {
    expect(CHECKLIST_STATUS_GLYPH.complete.Icon).toBe(STATUS_GLYPH['success-done'].Icon)
    expect(CHECKLIST_STATUS_GLYPH.complete.className).toBe(STATUS_GLYPH['success-done'].className)
  })

  it('in_progress_and_complete_differ_by_icon', () => {
    // They can share a colour on some presets, so the shape is what tells them apart.
    expect(CHECKLIST_STATUS_GLYPH.in_progress.Icon).not.toBe(CHECKLIST_STATUS_GLYPH.complete.Icon)
  })
})
