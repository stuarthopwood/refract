import { beforeEach, describe, expect, it } from 'vitest'
import { draftKey, selectItemDraft, useChecklistDraftsStore } from './checklist-drafts'

const store = useChecklistDraftsStore
const a = draftKey({ sessionId: 's1', checklistId: 'p1', itemId: 'a' })
const b = draftKey({ sessionId: 's1', checklistId: 'p1', itemId: 'b' })

beforeEach(() => {
  store.setState({ openKey: null, drafts: {}, inFlight: {}, notes: {} })
})

describe('useChecklistDraftsStore', () => {
  it('draft_survives_a_refused_send', () => {
    store.getState().open(a)
    store.getState().setText(a, 'my question')
    store.getState().beginSend(a)
    store.getState().refuse(a, 'Not sent.')
    expect(store.getState().drafts[a]).toEqual({ mode: 'ask', text: 'my question' })
    expect(store.getState().openKey).toBe(a)
    expect(store.getState().inFlight[a]).toBeUndefined()
    expect(store.getState().notes[a]).toEqual({ kind: 'refusal', message: 'Not sent.' })
  })

  it('draft_cleared_on_success', () => {
    store.getState().open(a, 'value')
    store.getState().setText(a, 'v')
    store.getState().beginSend(a)
    store.getState().succeed(a, { kind: 'delivery', delivery: 'queued' })
    expect(store.getState().drafts[a]).toBeUndefined()
    expect(store.getState().openKey).toBeNull()
    expect(store.getState().inFlight[a]).toBeUndefined()
    expect(store.getState().notes[a]).toEqual({ kind: 'delivery', delivery: 'queued' })
  })

  it('opening_another_item_closes_the_first', () => {
    store.getState().open(a)
    store.getState().open(b)
    expect(store.getState().openKey).toBe(b)
  })

  it('drafts_are_per_item', () => {
    store.getState().open(a)
    store.getState().setText(a, 'first')
    store.getState().open(b)
    store.getState().setText(b, 'second')
    expect(store.getState().drafts[a]?.text).toBe('first')
    expect(store.getState().drafts[b]?.text).toBe('second')
    store.getState().open(a)
    expect(store.getState().drafts[a]?.text).toBe('first')
  })

  it('keys_differ_across_sessions_and_checklists_for_the_same_item_id', () => {
    const keys = [
      draftKey({ sessionId: 's1', checklistId: 'p1', itemId: 'i1' }),
      draftKey({ sessionId: 's2', checklistId: 'p1', itemId: 'i1' }),
      draftKey({ sessionId: 's1', checklistId: 'p2', itemId: 'i1' })
    ]
    expect(new Set(keys).size).toBe(3)
  })

  it('closing_keeps_the_draft', () => {
    store.getState().open(a)
    store.getState().setText(a, 'kept')
    store.getState().close()
    expect(store.getState().openKey).toBeNull()
    expect(store.getState().drafts[a]?.text).toBe('kept')
  })

  it('opening_in_another_mode_keeps_the_text', () => {
    store.getState().open(a)
    store.getState().setText(a, 'typed')
    store.getState().open(a, 'value')
    expect(store.getState().drafts[a]).toEqual({ mode: 'value', text: 'typed' })
  })

  it('another_items_edit_leaves_this_items_draft_object_untouched', () => {
    store.getState().open(a)
    store.getState().setText(a, 'one')
    const before = selectItemDraft(store.getState(), a)
    store.getState().open(b)
    store.getState().setText(b, 'two')
    store.getState().beginSend(b)
    store.getState().succeed(b, null)
    expect(selectItemDraft(store.getState(), a)).toBe(before)
  })

  it('a_delivery_line_goes_when_the_form_opens_but_a_refusal_stays', () => {
    store.getState().succeed(a, { kind: 'delivery', delivery: 'held' })
    store.getState().open(a)
    expect(store.getState().notes[a]).toBeUndefined()
    store.getState().refuse(a, 'no')
    store.getState().close()
    store.getState().open(a)
    expect(store.getState().notes[a]).toEqual({ kind: 'refusal', message: 'no' })
  })
})
