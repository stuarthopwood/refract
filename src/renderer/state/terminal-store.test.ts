import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../../shared/ipc-terminal'
import { activeTab, selectSessionTerminals, useTerminalStore } from './terminal-store'

const tab = (id: string, order: number): TabInfo => ({
  id,
  sessionId: 's1',
  name: `Terminal ${order}`,
  cwd: 'C:/work',
  shell: 'pwsh',
  order,
  state: { kind: 'running' }
})

const list = vi.fn()
const create = vi.fn()

beforeEach(() => {
  list.mockReset()
  create.mockReset()
  vi.stubGlobal('window', { refract: { terminal: { list, create } } })
  useTerminalStore.setState({ bySession: {} })
})

describe('terminal store', () => {
  it('loads the tabs in order and adopts the saved active tab', async () => {
    list.mockResolvedValue({ ok: true, value: { tabs: [tab('b', 2), tab('a', 1)], activeTabId: 'b' } })
    await useTerminalStore.getState().load('s1')
    const session = selectSessionTerminals(useTerminalStore.getState(), 's1')
    expect(session.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(activeTab(session)?.id).toBe('b')
    expect(session.loaded).toBe(true)
  })

  it('asks Rust once while loaded and again only when forced', async () => {
    list.mockResolvedValue({ ok: true, value: { tabs: [], activeTabId: null } })
    await useTerminalStore.getState().load('s1')
    await useTerminalStore.getState().load('s1')
    expect(list).toHaveBeenCalledTimes(1)
    await useTerminalStore.getState().load('s1', true)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps a local tab choice across a forced reload', async () => {
    list.mockResolvedValue({ ok: true, value: { tabs: [tab('a', 1), tab('b', 2)], activeTabId: 'a' } })
    await useTerminalStore.getState().load('s1')
    useTerminalStore.getState().setActive('s1', 'b')
    await useTerminalStore.getState().load('s1', true)
    expect(selectSessionTerminals(useTerminalStore.getState(), 's1').activeTabId).toBe('b')
  })

  it('records a list failure as loaded with the message', async () => {
    list.mockResolvedValue({ ok: false, error: { code: 'x', message: 'no shell' } })
    await useTerminalStore.getState().load('s1')
    const session = selectSessionTerminals(useTerminalStore.getState(), 's1')
    expect(session).toMatchObject({ loaded: true, error: 'no shell', tabs: [] })
  })

  it('adds a created tab and makes it active; a refusal adds nothing', async () => {
    create.mockResolvedValueOnce({ ok: true, value: tab('a', 1) })
    expect((await useTerminalStore.getState().create('s1', 80, 24))?.id).toBe('a')
    expect(selectSessionTerminals(useTerminalStore.getState(), 's1').activeTabId).toBe('a')
    create.mockResolvedValueOnce({ ok: false, error: { code: 'terminal-limit', message: 'Eight terminals is the limit' } })
    expect(await useTerminalStore.getState().create('s1', 80, 24)).toBeNull()
    const session = selectSessionTerminals(useTerminalStore.getState(), 's1')
    expect(session.tabs).toHaveLength(1)
    expect(session.error).toBe('Eight terminals is the limit')
  })

  it('replaces a tab on a state event and appends an unknown one', () => {
    const store = useTerminalStore.getState()
    store.applyTabState({ sessionId: 's1', tab: tab('a', 1) })
    store.applyTabState({ sessionId: 's1', tab: { ...tab('a', 1), state: { kind: 'ended', code: 0 } } })
    store.applyTabState({ sessionId: 's1', tab: tab('b', 2) })
    const session = selectSessionTerminals(useTerminalStore.getState(), 's1')
    expect(session.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(session.tabs[0]?.state).toEqual({ kind: 'ended', code: 0 })
  })

  it('moves the active tab to the neighbour when the shown one is removed', () => {
    const store = useTerminalStore.getState()
    for (const t of [tab('a', 1), tab('b', 2), tab('c', 3)]) store.applyTabState({ sessionId: 's1', tab: t })
    store.setActive('s1', 'b')
    store.removeTab('s1', 'b')
    expect(selectSessionTerminals(useTerminalStore.getState(), 's1').activeTabId).toBe('c')
    store.removeTab('s1', 'c')
    expect(selectSessionTerminals(useTerminalStore.getState(), 's1').activeTabId).toBe('a')
  })

  it('drops Sessions that are gone', () => {
    const store = useTerminalStore.getState()
    store.applyTabState({ sessionId: 's1', tab: tab('a', 1) })
    store.applyTabState({ sessionId: 's2', tab: tab('b', 1) })
    store.pruneSessions(new Set(['s2']))
    expect(Object.keys(useTerminalStore.getState().bySession)).toEqual(['s2'])
  })
})
