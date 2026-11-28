import { describe, expect, it, vi } from 'vitest'
import type { Channel } from '@tauri-apps/api/core'
import type { TerminalApi } from '../shared/ipc-terminal'
import { terminalBridge } from './terminal'

function setup() {
  const request = vi.fn().mockResolvedValue({ ok: true, value: null })
  const on = vi.fn().mockReturnValue(() => {})
  const channels: Array<{ onmessage: (frame: ArrayBuffer) => void }> = []
  const makeChannel = () => {
    const channel = { onmessage: (_frame: ArrayBuffer) => {} }
    channels.push(channel)
    return channel as unknown as Channel<ArrayBuffer>
  }
  return { request, on, channels, bridge: terminalBridge(request as never, on as never, makeChannel) }
}

describe('terminalBridge', () => {
  it('attach_passes_the_channel_between_tab_id_and_size', async () => {
    const { bridge, request, channels } = setup()

    await bridge.attach('s1', 't1', 120, 30, () => {})

    expect(request).toHaveBeenCalledWith('terminal.attach', 's1', 't1', channels[0], 120, 30)
  })

  it('attach_delivers_channel_frames_to_the_callback_in_order', async () => {
    const { bridge, channels } = setup()
    const frames: number[] = []

    await bridge.attach('s1', 't1', 80, 24, (frame) => frames.push(new Uint8Array(frame)[0] ?? -1))
    const channel = channels[0]
    if (!channel) throw new Error('attach built no channel')
    channel.onmessage(new Uint8Array([1]).buffer)
    channel.onmessage(new Uint8Array([2]).buffer)

    expect(frames).toEqual([1, 2])
  })

  it('attach_returns_the_result_unchanged', async () => {
    const { bridge, request } = setup()
    const failure = { ok: false, error: { code: 'terminal-not-found', message: 'gone' } }
    request.mockResolvedValueOnce(failure)

    expect(await bridge.attach('s1', 't1', 80, 24, () => {})).toBe(failure)
  })

  it.each([
    ['list', (b: TerminalApi) => b.list('s1'), ['terminal.list', 's1']],
    ['create', (b: TerminalApi) => b.create('s1', 80, 24), ['terminal.create', 's1', 80, 24]],
    ['detach', (b: TerminalApi) => b.detach('t1'), ['terminal.detach', 't1']],
    ['input', (b: TerminalApi) => b.input('t1', 'ls\r'), ['terminal.input', 't1', 'ls\r']],
    ['resize', (b: TerminalApi) => b.resize('t1', 100, 40), ['terminal.resize', 't1', 100, 40]],
    ['ack', (b: TerminalApi) => b.ack('t1', 131072), ['terminal.ack', 't1', 131072]],
    ['close', (b: TerminalApi) => b.close('t1', true), ['terminal.close', 't1', true]],
    ['rename', (b: TerminalApi) => b.rename('t1', 'build'), ['terminal.rename', 't1', 'build']],
    ['restart', (b: TerminalApi) => b.restart('t1'), ['terminal.restart', 't1']],
    ['readOutput', (b: TerminalApi) => b.readOutput('t1', 'recent-command'), ['terminal.readOutput', 't1', 'recent-command']]
  ])('%s_sends_the_contract_channel_and_argument_order', async (_name, call, expected) => {
    const { bridge, request } = setup()

    await call(bridge)

    expect(request).toHaveBeenCalledWith(...expected)
  })

  it('on_tab_state_subscribes_to_the_tab_state_event', () => {
    const { bridge, on } = setup()
    const handler = vi.fn()

    bridge.onTabState(handler)

    expect(on).toHaveBeenCalledWith('terminal:tab-state', handler)
  })
})
