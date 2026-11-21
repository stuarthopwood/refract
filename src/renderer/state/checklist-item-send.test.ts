import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChecklist, makeItem } from '../features/right-pane/checklist/checklist-fixtures'
import { draftKey, useChecklistDraftsStore } from './checklist-drafts'
import { sendItemAction } from './checklist-item-send'
import { selectSessionChecklist, useChecklistStore } from './checklist-store'

const mutate = vi.fn()
const itemMessage = vi.fn()
const drafts = useChecklistDraftsStore
const key = draftKey({ sessionId: 's1', checklistId: 'p1', itemId: 'a' })
const send = (action: 'ask' | 'value' | 'complete', text: string | undefined, agentRunning: boolean) =>
  sendItemAction({ sessionId: 's1', itemId: 'a', action, text, agentRunning })

beforeEach(() => {
  useChecklistStore.setState({ bySession: {}, revealRequest: null })
  useChecklistStore.getState().applyUpdate({ sessionId: 's1', checklist: makeChecklist({ rev: 3, items: [makeItem({ id: 'a' })] }), by: 'developer' })
  drafts.setState({ openKey: null, drafts: {}, inFlight: {}, notes: {} })
  mutate.mockReset()
  itemMessage.mockReset()
  vi.stubGlobal('window', { refract: { checklist: { mutate, itemMessage } } })
  drafts.getState().open(key)
  drafts.getState().setText(key, 'typed')
})

describe('sendItemAction', () => {
  it('no_agent_value_saves_through_mutate_and_never_messages', async () => {
    const saved = makeChecklist({ rev: 4, items: [makeItem({ id: 'a', value: 'v', valueBy: 'developer' })] })
    mutate.mockResolvedValue({ ok: true, value: saved })
    drafts.getState().setMode(key, 'value')

    expect(await send('value', 'v', false)).toBe(true)

    expect(mutate).toHaveBeenCalledWith('s1', 'p1', 3, null, { op: 'setValue', id: 'a', value: 'v' })
    expect(itemMessage).not.toHaveBeenCalled()
    expect(selectSessionChecklist(useChecklistStore.getState(), 's1').checklist?.rev).toBe(4)
    expect(drafts.getState().drafts[key]).toBeUndefined()
    expect(drafts.getState().notes[key]).toMatchObject({ kind: 'delivery', delivery: 'saved' })
  })

  it('a_refused_save_keeps_the_draft_and_resyncs_the_checklist', async () => {
    const current = makeChecklist({ rev: 5, items: [makeItem({ id: 'a' })] })
    mutate.mockResolvedValue({ ok: true, value: { error: { code: 'item_changed', message: 'The item changed.' }, checklist: current } })

    expect(await send('value', 'v', false)).toBe(false)

    expect(selectSessionChecklist(useChecklistStore.getState(), 's1').checklist?.rev).toBe(5)
    expect(drafts.getState().drafts[key]?.text).toBe('typed')
    expect(drafts.getState().notes[key]).toMatchObject({ kind: 'refusal', message: 'Not saved. The item changed.' })
    expect(drafts.getState().inFlight[key]).toBeUndefined()
  })

  it('a_sent_ask_clears_the_draft_and_records_the_delivery', async () => {
    itemMessage.mockResolvedValue({ ok: true, value: { delivery: 'queued', checklist: makeChecklist({ rev: 4 }) } })

    expect(await send('ask', 'why?', true)).toBe(true)

    expect(itemMessage).toHaveBeenCalledWith('s1', 'p1', 'a', 3, 'ask', 'why?')
    expect(drafts.getState().drafts[key]).toBeUndefined()
    expect(drafts.getState().notes[key]).toMatchObject({ kind: 'delivery', delivery: 'queued' })
  })

  it('a_precheck_refusal_keeps_the_draft_and_says_the_value_is_still_in_the_box', async () => {
    itemMessage.mockResolvedValue({ ok: false, error: { code: 'agent-not-running', message: 'No agent.' } })
    drafts.getState().setMode(key, 'value')

    expect(await send('value', 'v', true)).toBe(false)

    expect(drafts.getState().drafts[key]).toEqual({ mode: 'value', text: 'typed' })
    expect(drafts.getState().notes[key]).toMatchObject({ kind: 'refusal', message: 'Not sent. Your value is still in the box. The agent is not running.' })
  })

  it('an_engine_refusal_says_the_value_was_not_stored', async () => {
    itemMessage.mockResolvedValue({ ok: true, value: { error: { code: 'item_changed', message: 'Changed.' }, checklist: makeChecklist({ rev: 6 }) } })
    drafts.getState().setMode(key, 'value')

    expect(await send('value', 'v', true)).toBe(false)

    expect(drafts.getState().notes[key]).toMatchObject({ kind: 'refusal', message: 'Not sent. Your value is still in the box. Reason: Changed.' })
    expect(selectSessionChecklist(useChecklistStore.getState(), 's1').checklist?.rev).toBe(6)
  })

  it('do_this_item_leaves_what_is_typed_in_place', async () => {
    itemMessage.mockResolvedValue({ ok: true, value: { delivery: 'sent', checklist: makeChecklist({ rev: 4 }) } })

    expect(await send('complete', undefined, true)).toBe(true)

    expect(itemMessage).toHaveBeenCalledWith('s1', 'p1', 'a', 3, 'complete', undefined)
    expect(drafts.getState().drafts[key]?.text).toBe('typed')
    expect(drafts.getState().openKey).toBe(key)
    expect(drafts.getState().inFlight[key]).toBeUndefined()
  })

  it('a_second_send_while_one_is_in_flight_is_dropped', async () => {
    drafts.getState().beginSend(key)

    expect(await send('ask', 'again', true)).toBe(false)

    expect(itemMessage).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('with_no_checklist_nothing_is_sent', async () => {
    useChecklistStore.setState({ bySession: {} })

    expect(await send('ask', 'q', true)).toBe(false)

    expect(itemMessage).not.toHaveBeenCalled()
  })

  it('a_developer_update_is_not_announced_as_the_agents', async () => {
    itemMessage.mockResolvedValue({ ok: true, value: { delivery: 'sent', checklist: makeChecklist({ rev: 4 }) } })
    await send('ask', 'q', true)

    expect(selectSessionChecklist(useChecklistStore.getState(), 's1').announcement).toBeNull()
  })
})
