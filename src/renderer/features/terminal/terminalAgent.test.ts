import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftStore } from '@/state/draft-store'
import { OUTPUT_CAP_BYTES } from '../../../shared/terminalLimits'
import { addToChat, askAgent, buildAskMessage, truncationNotice } from './terminalAgent'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'failed', message } })
const output = (text: string, truncated = false, totalBytes = text.length) => ok({ text, truncated, totalBytes, source: 'marker' as const })

const readOutput = vi.fn()
const send = vi.fn()

const draftText = (): string => useDraftStore.getState().bySession.s1?.text ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  useDraftStore.setState({ bySession: {} })
  readOutput.mockResolvedValue(output('recent output\n'))
  send.mockResolvedValue(ok(null))
  vi.stubGlobal('window', { refract: { terminal: { readOutput }, chat: { send } } })
})

describe('addToChat', () => {
  it('quotes the selection into the draft and never sends it', () => {
    expect(addToChat('s1', 'line one\n\nline two\n')).toBe(true)
    expect(draftText()).toBe('> line one\n>\n> line two\n\n')
    expect(send).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Added the selection to the message box')
  })

  it('does nothing for a blank selection', () => {
    expect(addToChat('s1', '  \n ')).toBe(false)
    expect(draftText()).toBe('')
    expect(toast).not.toHaveBeenCalled()
  })

  it.each([
    ['text with no line end', 'hello', 'hello\n\n> x\n\n'],
    ['text ending in one line end', 'hello\n', 'hello\n\n> x\n\n'],
    ['text ending in a blank line', 'hello\n\n', 'hello\n\n> x\n\n']
  ])('separates the quote from %s by exactly one blank line', (_name, existing, expected) => {
    useDraftStore.getState().setText('s1', existing)
    addToChat('s1', 'x')
    expect(draftText()).toBe(expected)
  })
})

describe('askAgent', () => {
  it('sends the selection as one turn without reading the terminal', async () => {
    await askAgent('s1', 't1', 'npm ERR! boom\n')
    expect(readOutput).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('s1', buildAskMessage({ text: 'npm ERR! boom\n', truncated: false, totalBytes: 14 }))
    expect(toast).not.toHaveBeenCalled()
  })

  it('falls back to the recent command when nothing is selected', async () => {
    await askAgent('s1', 't1', '   ')
    expect(readOutput).toHaveBeenCalledWith('t1', 'recent-command')
    expect(send).toHaveBeenCalledWith('s1', buildAskMessage({ text: 'recent output\n', truncated: false, totalBytes: 14 }))
  })

  it('adds the truncation line to the message and tells the developer when a selection is cut', async () => {
    const selection = `${'x'.repeat(OUTPUT_CAP_BYTES)}\ntail`
    await askAgent('s1', 't1', selection)
    const message = send.mock.calls[0]?.[1] as string
    expect(message).toContain(truncationNotice(selection.length))
    expect(message.trimEnd().endsWith('```')).toBe(true)
    expect(message).toContain('tail')
    expect(toast).toHaveBeenCalledWith(`Only the last ${OUTPUT_CAP_BYTES / 1024} KiB of the output was sent`)
  })

  it('reports truncation of the read fallback too', async () => {
    readOutput.mockResolvedValue(output('cut output', true, 99_999))
    await askAgent('s1', 't1', '')
    expect(send.mock.calls[0]?.[1]).toContain(truncationNotice(99_999))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Only the last'))
  })

  it('shows the read error and sends nothing when the terminal cannot be read', async () => {
    readOutput.mockResolvedValue(fail('Terminal not found'))
    await askAgent('s1', 't1', '')
    expect(toast.error).toHaveBeenCalledWith('Terminal not found')
    expect(send).not.toHaveBeenCalled()
  })

  it('says so and sends nothing when there is no output at all', async () => {
    readOutput.mockResolvedValue(output('  \n'))
    await askAgent('s1', 't1', '')
    expect(toast).toHaveBeenCalledWith('There is no terminal output to send yet')
    expect(send).not.toHaveBeenCalled()
  })

  it('shows the send error and skips the truncation notice when the turn is refused', async () => {
    send.mockResolvedValue(fail('Session is busy'))
    await askAgent('s1', 't1', `${'x'.repeat(OUTPUT_CAP_BYTES + 10)}`)
    expect(toast.error).toHaveBeenCalledWith('Session is busy')
    expect(toast).not.toHaveBeenCalled()
  })
})
