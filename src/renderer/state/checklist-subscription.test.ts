import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChecklistUpdatePayload } from '../../shared/ipc-checklist'
import { makeChecklist } from '../features/right-pane/checklist/checklist-fixtures'
import { initChecklistSubscription } from './checklist-subscription'
import { useSessionsStore } from './sessions-store'
import { selectSessionChecklist, useChecklistStore } from './checklist-store'
import { useDocumentTabsStore } from './document-tabs-store'
import { useRightPaneStore } from './right-pane-store'
import { useSplitStore } from './split-store'

const get = vi.fn()
let emit: (payload: ChecklistUpdatePayload) => void = () => {}
let dispose: () => void = () => {}

const send = (sessionId: string, opened?: true) => emit({ sessionId, checklist: makeChecklist(), by: 'agent', opened })
const pane = () => useRightPaneStore.getState()

beforeEach(() => {
  useChecklistStore.setState({ bySession: {}, revealRequest: null })
  useDocumentTabsStore.setState({ bySession: {} })
  useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0 })
  useRightPaneStore.setState({ open: false, openPanelIds: [], activePanelId: null, suppressNextContentFocus: false })
  get.mockReset().mockResolvedValue({ ok: true, value: { checklist: null, toolUnavailable: false } })
  vi.stubGlobal('window', {
    refract: {
      checklist: {
        get,
        onUpdate: (handler: (payload: ChecklistUpdatePayload) => void) => {
          emit = handler
          return () => {}
        }
      }
    }
  })
  dispose = initChecklistSubscription()
})

afterEach(() => dispose())

describe('initChecklistSubscription', () => {
  it('auto_opens_for_front_session', () => {
    send('s1', true)
    expect(pane().openPanelIds).toEqual(['checklist'])
    expect(pane().activePanelId).toBe('checklist')
    // Opened without stealing focus from whatever the developer is typing in.
    expect(pane().suppressNextContentFocus).toBe(true)
  })

  it('does_not_open_for_background_session', () => {
    send('other', true)
    expect(pane().openPanelIds).toEqual([])
    expect(selectSessionChecklist(useChecklistStore.getState(), 'other').checklist).not.toBeNull()
  })

  it('does_not_open_when_not_opened', () => {
    send('s1')
    expect(pane().openPanelIds).toEqual([])
    expect(selectSessionChecklist(useChecklistStore.getState(), 's1').checklist).not.toBeNull()
  })

  it('already_open_keeps_active_tab_and_document_tab', () => {
    const { id } = useDocumentTabsStore.getState().openDocumentTab('s1', { kind: 'file', path: 'a.ts' }, { activate: true })
    useRightPaneStore.setState({ open: true, openPanelIds: ['checklist', 'git-changes'], activePanelId: 'git-changes' })
    send('s1', true)
    expect(pane().activePanelId).toBe('git-changes')
    expect(useDocumentTabsStore.getState().bySession.s1?.activeId).toBe(id)
  })

  it('hydrates_on_front_change', () => {
    expect(get).toHaveBeenCalledWith('s1')
    useSplitStore.setState({ paneSessionIds: ['s1', 's2'], focusedIndex: 1 })
    expect(get).toHaveBeenLastCalledWith('s2')
    // A change that leaves the front Session alone must not refetch.
    get.mockClear()
    useSplitStore.setState({ dividerPercent: 40 })
    expect(get).not.toHaveBeenCalled()
  })

  it('refetches_the_front_session_when_its_status_changes', () => {
    // A launch registers host tools after the first hydrate, so a refusal only shows on a later fetch.
    useSessionsStore.setState({ sessions: [{ id: 's1', status: 'starting' } as never] })
    get.mockClear()
    useSessionsStore.setState({ sessions: [{ id: 's1', status: 'idle' } as never] })
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('s1')
    // Same status again, or another Session's change, must not refetch.
    useSessionsStore.setState({ sessions: [{ id: 's1', status: 'idle' } as never, { id: 's2', status: 'idle' } as never] })
    expect(get).toHaveBeenCalledTimes(1)
  })
})
