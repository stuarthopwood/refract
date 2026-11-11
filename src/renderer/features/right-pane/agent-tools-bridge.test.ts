// Spec 124 FR-019 (#1888): the renderer proceeds only on `accepted: true`; a failed IPC counts as a refusal.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signalStarted } from './agent-tools-bridge'
import type { AgentToolCall } from '../../../shared/ipc'

vi.mock('./agent-tool-dispatch', () => ({ invokePanelAction: vi.fn(), listPanels: vi.fn(), openPanel: vi.fn() }))

const call: AgentToolCall = { sessionId: 's1', callId: 'c1', tool: 'refract_invoke_panel_action', args: {} }
const started = vi.fn()

beforeEach(() => {
  started.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = { refract: { agentTools: { started } } }
})

describe('signalStarted', () => {
  it('names the Session and call Rust stamped, and resolves true when accepted', async () => {
    started.mockResolvedValue({ ok: true, value: { accepted: true } })
    expect(await signalStarted(call)).toBe(true)
    expect(started).toHaveBeenCalledWith('s1', 'c1')
  })

  it('resolves false when Rust refuses', async () => {
    started.mockResolvedValue({ ok: true, value: { accepted: false } })
    expect(await signalStarted(call)).toBe(false)
  })

  it('resolves false when the IPC fails', async () => {
    started.mockResolvedValue({ ok: false, error: { code: 'not-found', message: 'Session not found' } })
    expect(await signalStarted(call)).toBe(false)
  })
})
