import { describe, expect, it } from 'vitest'
import { makeItem } from './checklist-fixtures'
import { byteLength, canDoItem, deliveryLine, derivePresentation, isSendChord, refusalLine, sendBlock, sendLabel, showsDoItem } from './item-controls'

describe('item-controls', () => {
  it('awaiting_input_when_requires_value_and_no_value', () => {
    expect(derivePresentation(makeItem({ id: 'a', requiresValue: true }))).toBe('awaiting_input')
    expect(derivePresentation(makeItem({ id: 'a', requiresValue: true, value: 'v' }))).toBe('plain')
    expect(derivePresentation(makeItem({ id: 'a', requiresValue: true, status: 'complete' }))).toBe('plain')
  })

  it('in_progress_from_status', () => {
    expect(derivePresentation(makeItem({ id: 'a', status: 'in_progress' }))).toBe('in_progress')
    expect(derivePresentation(makeItem({ id: 'a', status: 'in_progress', requiresValue: true }))).toBe('in_progress')
  })

  it('do_item_needs_developer_value', () => {
    const needs = { id: 'a', requiresValue: true }
    expect(canDoItem(makeItem({ ...needs }))).toBe(false)
    expect(canDoItem(makeItem({ ...needs, value: 'v', valueBy: 'agent' }))).toBe(false)
    expect(canDoItem(makeItem({ ...needs, value: 'v', valueBy: 'developer' }))).toBe(true)
    expect(canDoItem(makeItem({ id: 'a' }))).toBe(true)
  })

  it('do_item_hidden_for_human_or_complete', () => {
    expect(showsDoItem(makeItem({ id: 'a', owner: 'human' }))).toBe(false)
    expect(showsDoItem(makeItem({ id: 'a', status: 'complete' }))).toBe(false)
    expect(showsDoItem(makeItem({ id: 'a', agentCompletable: false }))).toBe(false)
    expect(showsDoItem(makeItem({ id: 'a', owner: 'either' }))).toBe(true)
  })

  it('do_item_stays_shown_but_cannot_be_sent_while_in_progress', () => {
    const working = makeItem({ id: 'a', status: 'in_progress' })
    expect(showsDoItem(working)).toBe(true)
    expect(canDoItem(working)).toBe(false)
  })

  it('delivery_lines_for_sent_queued_held_not_running', () => {
    expect(deliveryLine('sent')).toBeNull()
    expect(deliveryLine('queued')).toBe('Queued after the current turn')
    expect(deliveryLine('held')).toBe('Held until you resume')
    expect(deliveryLine('not_running')).toBe('Agent not running')
  })

  it('byte_length_counts_utf8_bytes_not_characters', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('é')).toBe(2)
    expect(byteLength('😀')).toBe(4)
  })

  it('send_block_names_the_reason', () => {
    expect(sendBlock('ask', '   ', true)).toBe('Type something to send.')
    expect(sendBlock('value', 'x'.repeat(1025), true)).toBe('Too long to send.')
    expect(sendBlock('value', 'x'.repeat(1024), true)).toBeNull()
    expect(sendBlock('ask', 'x'.repeat(1025), true)).toBeNull()
    expect(sendBlock('ask', 'x'.repeat(4097), true)).toBe('Too long to send.')
    expect(sendBlock('ask', 'hello', false)).toContain('not running')
    expect(sendBlock('value', 'hello', false)).toBeNull()
  })

  it('refusal_line_says_what_was_kept', () => {
    expect(refusalLine('value', '')).toBe('Not sent. Your value is saved on the item.')
    expect(refusalLine('ask', 'Agent is busy.')).toBe('Not sent. Your question is still in the box. Agent is busy.')
    expect(refusalLine('complete', '')).toBe('Not sent. The item is unchanged.')
  })

  it('send_chord_needs_enter_with_ctrl_or_meta', () => {
    expect(isSendChord({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isSendChord({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true)
    expect(isSendChord({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false)
    expect(isSendChord({ key: 'a', ctrlKey: true, metaKey: false })).toBe(false)
  })

  it('send_label_reads_save_value_only_without_an_agent', () => {
    expect(sendLabel('value', false)).toBe('Save value')
    expect(sendLabel('value', true)).toBe('Send')
    expect(sendLabel('ask', false)).toBe('Send')
  })
})
