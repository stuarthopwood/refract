import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../../../shared/ipc-terminal'
import { createCloseController, type FocusTarget } from './closeFlow'

const tab: TabInfo = { id: 't1', sessionId: 's1', name: 'Terminal 1', cwd: 'C:/repo', shell: 'pwsh', order: 0, state: { kind: 'running' } }

const closed = { ok: true as const, value: { closed: true, needsConfirm: false } }
const busy = { ok: true as const, value: { closed: false, needsConfirm: true } }

const close = vi.fn()
const removeTab = vi.fn()
const fallbackFocus = vi.fn()

const invokerOf = (isConnected = true) => ({ isConnected, focus: vi.fn() }) satisfies FocusTarget
const controller = () => createCloseController({ api: { close }, removeTab, fallbackFocus })

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(closed)
})

describe('close flow', () => {
  it('closes an idle tab without a prompt and counts it so the view can rescue focus', async () => {
    const flow = controller()
    await flow.requestClose(tab, invokerOf())
    expect(close).toHaveBeenCalledExactlyOnceWith('t1', false)
    expect(removeTab).toHaveBeenCalledWith('t1')
    expect(flow.getState()).toMatchObject({ pending: null, busy: false, idleCloses: 1 })
  })

  it('asks first when a job is running and keeps the tab until the developer answers', async () => {
    close.mockResolvedValue(busy)
    const flow = controller()
    await flow.requestClose(tab)
    expect(flow.getState().pending).toEqual(tab)
    expect(removeTab).not.toHaveBeenCalled()
  })

  it('force-closes the tab the prompt asks about on confirm', async () => {
    close.mockResolvedValueOnce(busy)
    const flow = controller()
    await flow.requestClose(tab)
    await flow.confirm()
    expect(close).toHaveBeenLastCalledWith('t1', true)
    expect(removeTab).toHaveBeenCalledWith('t1')
    expect(flow.getState()).toMatchObject({ pending: null, idleCloses: 0 })
  })

  it('keeps the tab on cancel and gives the keyboard back to the control that started the close', async () => {
    close.mockResolvedValue(busy)
    const flow = controller()
    const invoker = invokerOf()
    await flow.requestClose(tab, invoker)
    flow.cancel()
    flow.restoreFocus()
    expect(flow.getState().pending).toBeNull()
    expect(removeTab).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(invoker.focus).toHaveBeenCalledOnce()
    expect(fallbackFocus).not.toHaveBeenCalled()
  })

  it('falls back to the terminal on cancel when the invoker is gone', async () => {
    close.mockResolvedValue(busy)
    const flow = controller()
    const invoker = invokerOf(false)
    await flow.requestClose(tab, invoker)
    flow.cancel()
    flow.restoreFocus()
    expect(invoker.focus).not.toHaveBeenCalled()
    expect(fallbackFocus).toHaveBeenCalledOnce()
  })

  it('falls back to the terminal when nothing started the close', async () => {
    close.mockResolvedValue(busy)
    const flow = controller()
    await flow.requestClose(tab)
    flow.cancel()
    flow.restoreFocus()
    expect(fallbackFocus).toHaveBeenCalledOnce()
  })

  it('never focuses a control of a tab that was force-closed', async () => {
    close.mockResolvedValueOnce(busy)
    const flow = controller()
    const invoker = invokerOf()
    await flow.requestClose(tab, invoker)
    await flow.confirm()
    flow.restoreFocus()
    expect(invoker.focus).not.toHaveBeenCalled()
    expect(fallbackFocus).toHaveBeenCalledOnce()
  })

  it('does not reuse an earlier invoker for a later close', async () => {
    close.mockResolvedValue(busy)
    const flow = controller()
    const first = invokerOf()
    await flow.requestClose(tab, first)
    flow.cancel()
    flow.restoreFocus()
    await flow.requestClose(tab)
    flow.cancel()
    flow.restoreFocus()
    expect(first.focus).toHaveBeenCalledOnce()
    expect(fallbackFocus).toHaveBeenCalledOnce()
  })

  it('surfaces a refused close and keeps the tab', async () => {
    close.mockResolvedValue({ ok: false, error: { code: 'terminal-not-found', message: 'Tab not found' } })
    const flow = controller()
    await flow.requestClose(tab)
    expect(flow.getState()).toMatchObject({ pending: null, busy: false, error: 'Tab not found' })
    expect(removeTab).not.toHaveBeenCalled()
  })

  it('does nothing on confirm when no prompt is open', async () => {
    const flow = controller()
    await flow.confirm()
    expect(close).not.toHaveBeenCalled()
  })

  it('tells subscribers about each change until they unsubscribe', async () => {
    const flow = controller()
    const listener = vi.fn()
    const unsubscribe = flow.subscribe(listener)
    await flow.requestClose(tab)
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    unsubscribe()
    flow.cancel()
    expect(listener).not.toHaveBeenCalled()
  })
})
