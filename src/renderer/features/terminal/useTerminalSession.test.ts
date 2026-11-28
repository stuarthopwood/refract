import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACK_EVERY_BYTES, INPUT_MAX_BYTES } from '../../../shared/terminalLimits'
import { FRAME_TAG_DATA, FRAME_TAG_EXIT } from '../../../shared/ipc-terminal'
import { createTerminalLink, RESIZE_DEBOUNCE_MS } from './useTerminalSession'
import type { TerminalBridge } from './useTerminalSession'

const ok = <T,>(value: T) => ({ ok: true as const, value })

function dataFrame(bytes: number[] | number): ArrayBuffer {
  const body = typeof bytes === 'number' ? new Array<number>(bytes).fill(65) : bytes
  return Uint8Array.from([FRAME_TAG_DATA, ...body]).buffer
}

function setup() {
  const sinks: Array<(frame: ArrayBuffer) => void> = []
  const bridge = {
    attach: vi.fn(async (_s: string, _t: string, _c: number, _r: number, onFrame: (frame: ArrayBuffer) => void) => {
      sinks.push(onFrame)
      return ok({ state: { kind: 'running' as const } })
    }),
    detach: vi.fn(async (_tabId: string) => ok(null)),
    input: vi.fn(async (_tabId: string, _data: string) => ok(null)),
    resize: vi.fn(async (_tabId: string, _cols: number, _rows: number) => ok(null)),
    ack: vi.fn(async (_tabId: string, _bytes: number) => ok(null))
  }
  const written: number[][] = []
  const callbacks: Array<() => void> = []
  // Mutable on purpose: tests resize the pane by assigning `cols`.
  const surface = {
    cols: 80,
    rows: 24,
    write: vi.fn((data: Uint8Array, callback?: () => void) => {
      written.push([...data])
      if (callback) callbacks.push(callback)
    }),
    reset: vi.fn()
  }
  const fit = vi.fn()
  const link = createTerminalLink(bridge as unknown as TerminalBridge, surface, fit)
  const emit = (index: number, frame: ArrayBuffer): void => {
    const sink = sinks[index]
    if (!sink) throw new Error(`no attach #${index}`)
    sink(frame)
  }
  return { bridge, surface, fit, link, emit, written, flush: () => callbacks.splice(0).forEach((cb) => cb()) }
}

describe('terminal link', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('attaches with the measured size and clears the screen the ring replay refills', async () => {
    const { bridge, surface, link } = setup()
    const outcome = await link.attach('s1', 't1')
    expect(outcome).toEqual({ kind: 'attached', state: { kind: 'running' } })
    expect(surface.reset).toHaveBeenCalledTimes(1)
    expect(bridge.attach).toHaveBeenCalledWith('s1', 't1', 80, 24, expect.any(Function))
  })

  it('writes data frames in arrival order and ignores frames that carry no output', async () => {
    const { link, emit, written } = setup()
    await link.attach('s1', 't1')
    emit(0, dataFrame([1, 2]))
    emit(0, Uint8Array.from([FRAME_TAG_EXIT, 0, 0, 0, 0]).buffer)
    emit(0, dataFrame([3]))
    expect(written).toEqual([[1, 2], [3]])
  })

  it('acks the written bytes once the threshold is passed, and only after xterm has written them', async () => {
    const { bridge, link, emit, flush } = setup()
    await link.attach('s1', 't1')
    emit(0, dataFrame(ACK_EVERY_BYTES - 1))
    flush()
    expect(bridge.ack).not.toHaveBeenCalled()
    emit(0, dataFrame(1))
    expect(bridge.ack).not.toHaveBeenCalled()
    flush()
    expect(bridge.ack).toHaveBeenCalledWith('t1', ACK_EVERY_BYTES)
  })

  it('detaches the previous tab before attaching the next, so a switch never leaves two sinks open', async () => {
    const { bridge, link } = setup()
    await link.attach('s1', 't1')
    await link.attach('s1', 't2')
    expect(bridge.detach).toHaveBeenCalledWith('t1')
    const detachedAt = bridge.detach.mock.invocationCallOrder[0] ?? Infinity
    const secondAttachAt = bridge.attach.mock.invocationCallOrder[1] ?? 0
    expect(detachedAt).toBeLessThan(secondAttachAt)
  })

  it('drops frames from a tab that is no longer shown', async () => {
    const { link, emit, written } = setup()
    await link.attach('s1', 't1')
    await link.attach('s1', 't2')
    emit(0, dataFrame([9]))
    emit(1, dataFrame([7]))
    expect(written).toEqual([[7]])
  })

  it('reports a superseded attach and releases its sink when the tab was replaced in flight', async () => {
    const { bridge, link } = setup()
    // The project's TS lib predates `Promise.withResolvers`, so the resolver is captured by hand.
    type AttachReply = Awaited<ReturnType<typeof bridge.attach>>
    let resolveFirst: (reply: AttachReply) => void = () => undefined
    const pending = new Promise<AttachReply>((resolve) => {
      resolveFirst = resolve
    })
    bridge.attach.mockImplementationOnce(() => pending)
    const first = link.attach('s1', 't1')
    const second = link.attach('s1', 't2')
    resolveFirst(ok({ state: { kind: 'running' } }))
    expect(await first).toEqual({ kind: 'superseded' })
    expect((await second).kind).toBe('attached')
    expect(bridge.detach).toHaveBeenCalledWith('t1')
  })

  it('surfaces an attach failure without terminal content', async () => {
    const { bridge, link } = setup()
    bridge.attach.mockResolvedValueOnce({ ok: false, error: { code: 'terminal-not-found', message: 'Tab not found' } } as never)
    expect(await link.attach('s1', 't1')).toEqual({ kind: 'failed', message: 'Tab not found' })
  })

  it('sends input to the shown tab in order, and nothing once detached', async () => {
    const { bridge, link } = setup()
    link.sendInput('ignored')
    await link.attach('s1', 't1')
    link.sendInput('ls')
    link.sendInput('\r')
    await vi.runAllTimersAsync()
    expect(bridge.input.mock.calls).toEqual([
      ['t1', 'ls'],
      ['t1', '\r']
    ])
    link.detach()
    link.sendInput('late')
    await vi.runAllTimersAsync()
    expect(bridge.input).toHaveBeenCalledTimes(2)
  })

  it('splits a paste larger than the per-call limit without cutting a character in half', async () => {
    const { bridge, link } = setup()
    await link.attach('s1', 't1')
    const paste = '😀'.repeat(INPUT_MAX_BYTES / 2)
    link.sendInput(paste)
    await vi.runAllTimersAsync()
    const parts = bridge.input.mock.calls.map((call) => call[1])
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(paste)
    for (const part of parts) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(INPUT_MAX_BYTES)
      expect(part).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/)
    }
  })

  it('forwards one resize after the pane stops moving, and none when the size did not change', async () => {
    const { bridge, surface, fit, link } = setup()
    await link.attach('s1', 't1')
    link.requestFit()
    link.requestFit()
    expect(fit).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS)
    expect(bridge.resize).not.toHaveBeenCalled()
    surface.cols = 100
    link.requestFit()
    link.requestFit()
    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS)
    expect(bridge.resize).toHaveBeenCalledTimes(1)
    expect(bridge.resize).toHaveBeenCalledWith('t1', 100, 24)
  })

  it('does not touch the shell when it is disposed; it only stops showing the tab', async () => {
    const { bridge, link } = setup()
    await link.attach('s1', 't1')
    link.dispose()
    expect(bridge.detach).toHaveBeenCalledWith('t1')
    expect(bridge.input).not.toHaveBeenCalled()
  })
})
