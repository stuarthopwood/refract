import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectSessionChecklist, useChecklistStore } from '@/state/checklist-store'
import { makeChecklist, makeItem } from './checklist-fixtures'
import { ANNOUNCEMENT_FRESH_MS, SILENT_LINE, nextLine } from './useChecklistAnnouncer'

const store = () => useChecklistStore.getState()
const heard = (sessionId = 's1') => nextLine(SILENT_LINE, store().takeAnnouncement(sessionId), Date.now())

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  useChecklistStore.setState({ bySession: {}, revealRequest: null })
})

afterEach(() => vi.useRealTimers())

describe('useChecklistAnnouncer line', () => {
  it('announces_opened_with_title_and_count', () => {
    store().applyUpdate({ sessionId: 's1', checklist: makeChecklist({ title: 'Plan', items: [makeItem({ id: 'a' }), makeItem({ id: 'b' })] }), by: 'agent', opened: true })
    expect(heard().message).toBe('Checklist opened: Plan, 2 items')
  })

  it('announces_replaced', () => {
    store().applyUpdate({ sessionId: 's1', checklist: makeChecklist({ id: 'p1' }), by: 'agent', opened: true })
    store().takeAnnouncement('s1')
    store().applyUpdate({ sessionId: 's1', checklist: makeChecklist({ id: 'p2' }), by: 'agent' })
    expect(heard().message).toBe('Checklist replaced')
  })

  it('announces_agent_change_not_developer_tick', () => {
    store().applyUpdate({ sessionId: 's1', checklist: makeChecklist({ items: [makeItem({ id: 'a', text: 'Write' })] }), by: 'agent', opened: true })
    store().takeAnnouncement('s1')
    const ticked = makeChecklist({ rev: 2, items: [makeItem({ id: 'a', text: 'Write', status: 'complete' })] })
    store().applyUpdate({ sessionId: 's1', checklist: ticked, by: 'developer' })
    expect(selectSessionChecklist(useChecklistStore.getState(), 's1').announcement).toBeNull()
    expect(heard()).toBe(SILENT_LINE)
    store().applyUpdate({ sessionId: 's1', checklist: makeChecklist({ rev: 3, items: [makeItem({ id: 'a', text: 'Write', status: 'blocked' })] }), by: 'agent' })
    expect(heard().message).toBe('Write is now blocked')
  })

  it('serial_changes_for_a_repeated_sentence', () => {
    const line = { message: 'x', serial: 4 }
    const again = nextLine(line, { message: 'x', at: 1000 }, 1000)
    expect(again).toEqual({ message: 'x', serial: 5 })
  })

  it('stale_announcement_is_not_news', () => {
    const line = { message: 'old', serial: 1 }
    expect(nextLine(line, { message: 'late', at: 1000 }, 1000 + ANNOUNCEMENT_FRESH_MS + 1)).toBe(line)
    expect(nextLine(line, { message: 'edge', at: 1000 }, 1000 + ANNOUNCEMENT_FRESH_MS).message).toBe('edge')
  })

  it('nothing_taken_keeps_the_line', () => {
    const line = { message: 'old', serial: 1 }
    expect(nextLine(line, null, 5)).toBe(line)
  })
})
