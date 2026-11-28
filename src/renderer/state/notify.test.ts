import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { info, error, dismiss } = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info, error, dismiss } }))

import { dismissSlashCommandRefusalToast, notifyComposerRefusal, notifyInfo } from './notify'

describe('notifyInfo (#2135)', () => {
  const region = { textContent: '', isConnected: true, setAttribute: vi.fn(), className: '' }

  beforeEach(() => {
    vi.useFakeTimers()
    region.textContent = ''
    vi.stubGlobal('document', { createElement: () => region, body: { appendChild: vi.fn() } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    info.mockClear()
  })

  // The live region is created on the first announcement and reused, so its attributes are asserted here.
  it('announces the text in an assertive live region', () => {
    notifyInfo('Already closed')
    vi.runAllTimers()

    expect(region.setAttribute).toHaveBeenCalledWith('aria-live', 'assertive')
    expect(region.textContent).toBe('Already closed')
  })

  it('shows an info toast on the default duration, with a close button', () => {
    notifyInfo('Already closed')

    expect(info).toHaveBeenCalledWith('Already closed', { id: 'info:Already closed', closeButton: true })
  })
})

// Options of the most recent error toast; sonner's `toast.error(text, options)` second argument.
function lastErrorOptions(): { id: string; onDismiss: () => void } {
  return error.mock.lastCall?.[1] as { id: string; onDismiss: () => void }
}

describe('notifyComposerRefusal (#1827)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => ({ setAttribute: vi.fn(), isConnected: true }), body: { appendChild: vi.fn() } })
  })

  afterEach(() => {
    dismissSlashCommandRefusalToast('s1')
    vi.unstubAllGlobals()
    error.mockClear()
    dismiss.mockClear()
  })

  it('is dismissed by the next successful send in the same Session', () => {
    notifyComposerRefusal("A slash command can't be the first message of /new", 's1')
    const refusalId = lastErrorOptions().id

    dismissSlashCommandRefusalToast('s1')

    expect(dismiss).toHaveBeenCalledWith(refusalId)
  })

  it('survives a send in a different Session', () => {
    notifyComposerRefusal('refused', 's1')

    dismissSlashCommandRefusalToast('s2')

    expect(dismiss).not.toHaveBeenCalled()
  })

  it('replaces the previous refusal rather than stacking', () => {
    notifyComposerRefusal('first', 's1')
    const firstId = lastErrorOptions().id

    notifyComposerRefusal('second', 's1')

    expect(dismiss).toHaveBeenCalledWith(firstId)
  })

  it('is not dismissed twice after the developer closes it', () => {
    notifyComposerRefusal('refused', 's1')
    lastErrorOptions().onDismiss()

    dismissSlashCommandRefusalToast('s1')

    expect(dismiss).not.toHaveBeenCalled()
  })
})
