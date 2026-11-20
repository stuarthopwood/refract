import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChecklist, makeItem } from '../features/right-pane/checklist/checklist-fixtures'
import { selectSessionChecklist, useChecklistStore } from './checklist-store'

const get = vi.fn()
const mutate = vi.fn()

const read = (sessionId: string) => selectSessionChecklist(useChecklistStore.getState(), sessionId)
const update = (sessionId: string, checklist = makeChecklist(), by: 'agent' | 'developer' = 'agent', opened?: true) =>
  useChecklistStore.getState().applyUpdate({ sessionId, checklist, by, opened })

beforeEach(() => {
  useChecklistStore.setState({ bySession: {}, revealRequest: null })
  get.mockReset().mockResolvedValue({ ok: true, value: { checklist: null, toolUnavailable: false } })
  mutate.mockReset()
  vi.stubGlobal('window', { refract: { checklist: { get, mutate } } })
})

describe('useChecklistStore.applyUpdate', () => {
  it('drops_stale_rev', () => {
    update('s1', makeChecklist({ rev: 5, title: 'new' }))
    expect(update('s1', makeChecklist({ rev: 4, title: 'old' }))).toBe(false)
    expect(read('s1').checklist?.title).toBe('new')
  })

  it('drops_equal_rev', () => {
    update('s1', makeChecklist({ rev: 5, title: 'first' }))
    expect(update('s1', makeChecklist({ rev: 5, title: 'second' }))).toBe(false)
    expect(read('s1').checklist?.title).toBe('first')
  })

  it('accepts_higher_rev', () => {
    update('s1', makeChecklist({ rev: 5 }))
    expect(update('s1', makeChecklist({ rev: 6 }))).toBe(true)
    expect(read('s1').checklist?.rev).toBe(6)
  })

  it('separate_sessions_do_not_interfere', () => {
    update('s1', makeChecklist({ rev: 9 }))
    expect(update('s2', makeChecklist({ rev: 1 }))).toBe(true)
    expect(read('s1').checklist?.rev).toBe(9)
    expect(read('s2').checklist?.rev).toBe(1)
  })

  it('new_checklist_id_replaces', () => {
    update('s1', makeChecklist({ id: 'p1', rev: 9 }))
    expect(update('s1', makeChecklist({ id: 'p2', rev: 1 }))).toBe(true)
    expect(read('s1').checklist?.id).toBe('p2')
  })

  it('agent_update_clears_tool_unavailable_but_developer_update_does_not', () => {
    useChecklistStore.setState({ bySession: { s1: { ...read('s1'), toolUnavailable: true } } })
    update('s1', makeChecklist({ rev: 1 }), 'developer')
    expect(read('s1').toolUnavailable).toBe(true)
    update('s1', makeChecklist({ rev: 2 }), 'agent')
    expect(read('s1').toolUnavailable).toBe(false)
  })
})

describe('useChecklistStore announcements', () => {
  it('opened_update_queues_an_opened_line', () => {
    update('s1', makeChecklist({ title: 'Plan', items: [makeItem({ id: 'a' }), makeItem({ id: 'b' })] }), 'agent', true)
    expect(useChecklistStore.getState().takeAnnouncement('s1')?.message).toBe('Checklist opened: Plan, 2 items')
    expect(useChecklistStore.getState().takeAnnouncement('s1')).toBeNull()
  })

  it('replacing_checklist_queues_a_replaced_line', () => {
    update('s1', makeChecklist({ id: 'p1' }))
    update('s1', makeChecklist({ id: 'p2' }), 'agent', true)
    expect(useChecklistStore.getState().takeAnnouncement('s1')?.message).toBe('Checklist replaced')
  })

  it('developer_update_queues_nothing', () => {
    update('s1', makeChecklist({ rev: 1 }))
    update('s1', makeChecklist({ rev: 2, items: [makeItem({ id: 'i1', status: 'complete' })] }), 'developer')
    expect(read('s1').announcement).toBeNull()
  })
})

describe('useChecklistStore.hydrate', () => {
  it('hydrate_sets_flag', async () => {
    get.mockResolvedValue({ ok: true, value: { checklist: makeChecklist(), toolUnavailable: true } })
    await useChecklistStore.getState().hydrate('s1')
    expect(read('s1')).toMatchObject({ toolUnavailable: true, loaded: true, error: null })
    expect(read('s1').checklist?.id).toBe('p1')
  })

  it('hydrate_error_sets_error_state', async () => {
    get.mockResolvedValue({ ok: false, error: { code: 'store-failed', message: 'disk said no' } })
    await useChecklistStore.getState().hydrate('s1')
    expect(read('s1')).toMatchObject({ error: 'disk said no', loaded: true, checklist: null })
  })

  it('hydrate_keeps_a_newer_held_checklist', async () => {
    update('s1', makeChecklist({ rev: 7 }))
    get.mockResolvedValue({ ok: true, value: { checklist: makeChecklist({ rev: 3 }), toolUnavailable: false } })
    await useChecklistStore.getState().hydrate('s1')
    expect(read('s1').checklist?.rev).toBe(7)
  })
})

describe('useChecklistStore.reveal', () => {
  it('reveal_request_one_shot', () => {
    useChecklistStore.getState().requestReveal({ sessionId: 's1', checklistId: 'p1', itemId: 'i1' })
    expect(useChecklistStore.getState().revealRequest).toEqual({ sessionId: 's1', checklistId: 'p1', itemId: 'i1' })
    useChecklistStore.getState().clearReveal()
    expect(useChecklistStore.getState().revealRequest).toBeNull()
  })
})

describe('useChecklistStore.mutateItem', () => {
  const seed = (item = makeItem({ id: 'i1' }), sessionId = 's1') => update(sessionId, makeChecklist({ rev: 4, items: [item] }))

  // The TS lib target predates `Promise.withResolvers`.
  const deferred = (): { promise: Promise<unknown>; resolve: (value: unknown) => void } => {
    let resolve: (value: unknown) => void = () => undefined
    const promise = new Promise<unknown>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it('sends_base_rev_as_rendered', async () => {
    seed()
    mutate.mockResolvedValue({ ok: true, value: makeChecklist({ rev: 5 }) })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(mutate).toHaveBeenCalledWith('s1', 'p1', 4, null, { op: 'setStatus', id: 'i1', status: 'complete' })
  })

  it('no_optimistic_status_before_result', async () => {
    seed()
    const { promise, resolve: release } = deferred()
    mutate.mockReturnValue(promise)
    const pending = useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(read('s1').checklist?.items[0]?.status).toBe('upcoming')
    expect(read('s1').pending).toEqual({ i1: true })
    release({ ok: true, value: makeChecklist({ rev: 5, items: [makeItem({ id: 'i1', status: 'complete' })] }) })
    await pending
    expect(read('s1').checklist?.items[0]?.status).toBe('complete')
    expect(read('s1').pending).toEqual({})
  })

  it('does_not_send_a_second_request_while_pending', async () => {
    seed()
    mutate.mockReturnValue(deferred().promise)
    void useChecklistStore.getState().mutateItem('s1', 'i1')
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('refusal_applies_returned_checklist', async () => {
    seed()
    const latest = makeChecklist({ rev: 6, items: [makeItem({ id: 'i1', status: 'in_progress', rev: 6 })] })
    mutate.mockResolvedValue({ ok: true, value: { error: { code: 'item_changed', message: 'changed' }, checklist: latest } })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(read('s1').checklist).toEqual(latest)
    expect(read('s1').pending).toEqual({})
  })

  it('item_changed_refusal_recorded_with_status', async () => {
    seed()
    const latest = makeChecklist({ rev: 6, items: [makeItem({ id: 'i1', status: 'blocked', rev: 6 })] })
    mutate.mockResolvedValue({ ok: true, value: { error: { code: 'item_changed', message: 'changed' }, checklist: latest } })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(read('s1').refusals.i1).toEqual({ code: 'item_changed', message: 'changed', status: 'blocked' })
  })

  it('refusal_clears_when_the_item_changes_again', async () => {
    seed()
    const latest = makeChecklist({ rev: 6, items: [makeItem({ id: 'i1', status: 'blocked', rev: 6 })] })
    mutate.mockResolvedValue({ ok: true, value: { error: { code: 'item_changed', message: 'changed' }, checklist: latest } })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    update('s1', makeChecklist({ rev: 7, items: [makeItem({ id: 'i1', status: 'next', rev: 7 })] }))
    expect(read('s1').refusals).toEqual({})
  })

  it('failed_call_is_recorded_inline_and_clears_pending', async () => {
    seed()
    mutate.mockResolvedValue({ ok: false, error: { code: 'unknown_session', message: 'gone' } })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(read('s1').refusals.i1).toEqual({ code: 'unknown_session', message: 'gone' })
    expect(read('s1').pending).toEqual({})
  })

  it('late_result_lands_in_captured_session', async () => {
    seed(makeItem({ id: 'i1' }), 's1')
    update('s2', makeChecklist({ id: 'q1', rev: 1 }))
    const { promise, resolve: release } = deferred()
    mutate.mockReturnValue(promise)
    const pending = useChecklistStore.getState().mutateItem('s1', 'i1')
    release({ ok: true, value: makeChecklist({ rev: 5, title: 'applied' }) })
    await pending
    expect(read('s1').checklist?.title).toBe('applied')
    expect(read('s2').checklist?.id).toBe('q1')
    expect(read('s2').checklist?.title).toBe('Ship it')
  })

  it('untick_sends_previous_status', async () => {
    seed(makeItem({ id: 'i1', status: 'complete', previousStatus: 'in_progress' }))
    mutate.mockResolvedValue({ ok: true, value: makeChecklist({ rev: 5 }) })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(mutate).toHaveBeenCalledWith('s1', 'p1', 4, null, { op: 'setStatus', id: 'i1', status: 'in_progress' })
  })

  it('untick_without_previous_status_falls_back_to_upcoming', async () => {
    seed(makeItem({ id: 'i1', status: 'complete' }))
    mutate.mockResolvedValue({ ok: true, value: makeChecklist({ rev: 5 }) })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(mutate).toHaveBeenCalledWith('s1', 'p1', 4, null, { op: 'setStatus', id: 'i1', status: 'upcoming' })
  })

  it('requires_value_without_value_not_sent', async () => {
    seed(makeItem({ id: 'i1', requiresValue: true }))
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(mutate).not.toHaveBeenCalled()
    expect(read('s1').pending).toEqual({})
  })

  it('requires_value_with_value_is_sent', async () => {
    seed(makeItem({ id: 'i1', requiresValue: true, value: 'abc' }))
    mutate.mockResolvedValue({ ok: true, value: makeChecklist({ rev: 5 }) })
    await useChecklistStore.getState().mutateItem('s1', 'i1')
    expect(mutate).toHaveBeenCalledTimes(1)
  })
})
