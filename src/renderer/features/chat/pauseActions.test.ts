import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setAllPaused } from './pauseActions'

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/state', () => ({ notify }))

const resumeAll = vi.fn()
const pauseAll = vi.fn()

beforeEach(() => {
  notify.mockClear()
  vi.stubGlobal('window', { refract: { chat: { resumeAll, pauseAll } } })
})

describe('setAllPaused', () => {
  it('reports how many resumed and how many failed to start', async () => {
    resumeAll.mockResolvedValue({ ok: true, value: { count: 3, failed: 2 } })
    await setAllPaused(false)
    expect(notify).toHaveBeenCalledWith({ code: 'resume-failed', message: 'Resumed 3, 2 failed to start' })
  })

  it('stays silent when every Session resumed', async () => {
    resumeAll.mockResolvedValue({ ok: true, value: { count: 3, failed: 0 } })
    await setAllPaused(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not report resume failures when pausing all', async () => {
    pauseAll.mockResolvedValue({ ok: true, value: { count: 2, failed: 1 } })
    await setAllPaused(true)
    expect(notify).not.toHaveBeenCalled()
  })

  it('surfaces the backend error when the call itself fails', async () => {
    resumeAll.mockResolvedValue({ ok: false, error: { code: 'boom', message: 'nope' } })
    await setAllPaused(false)
    expect(notify).toHaveBeenCalledWith({ code: 'boom', message: 'nope' })
  })
})
