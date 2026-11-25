import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const info = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { info } }))

import { notifyInfo } from './notify'

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
