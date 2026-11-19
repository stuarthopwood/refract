import { describe, expect, it, vi } from 'vitest'
import type { IpcError } from '../../../shared/ipc'
import { copyAbsolutePath, type CopyPathDeps } from './copy-path'

const error: IpcError = { code: 'invalid-argument', message: 'nope' }

function setup(overrides: Partial<CopyPathDeps> = {}) {
  const deps = {
    sessionId: 's1',
    worktreePath: 'C:\\repo',
    path: 'src/a.ts',
    confirm: false,
    writeClipboard: vi.fn(() => Promise.resolve()),
    copyViaIpc: vi.fn(() => Promise.resolve({ ok: true as const })),
    notifyError: vi.fn(),
    confirmCopied: vi.fn(),
    ...overrides
  }
  return deps
}

describe('copyAbsolutePath', () => {
  it('does nothing without a Session', async () => {
    const deps = setup({ sessionId: null })
    expect(await copyAbsolutePath(deps)).toBe(false)
    expect(deps.writeClipboard).not.toHaveBeenCalled()
    expect(deps.copyViaIpc).not.toHaveBeenCalled()
  })

  it('writes the absolute path to the clipboard first, without the IPC copy', async () => {
    const deps = setup()
    expect(await copyAbsolutePath(deps)).toBe(true)
    expect(deps.writeClipboard).toHaveBeenCalledWith('C:\\repo\\src\\a.ts')
    expect(deps.copyViaIpc).not.toHaveBeenCalled()
  })

  it('falls back to the IPC copy when the clipboard throws', async () => {
    const deps = setup({ writeClipboard: vi.fn(() => Promise.reject(new Error('denied'))) })
    expect(await copyAbsolutePath(deps)).toBe(true)
    expect(deps.copyViaIpc).toHaveBeenCalledWith('s1', 'src/a.ts')
  })

  it('goes straight to the IPC copy when the worktree path is unknown', async () => {
    const deps = setup({ worktreePath: undefined })
    expect(await copyAbsolutePath(deps)).toBe(true)
    expect(deps.writeClipboard).not.toHaveBeenCalled()
    expect(deps.copyViaIpc).toHaveBeenCalledOnce()
  })

  it('confirms with a toast only when asked, on either route', async () => {
    const quiet = setup()
    await copyAbsolutePath(quiet)
    expect(quiet.confirmCopied).not.toHaveBeenCalled()

    const viaClipboard = setup({ confirm: true })
    await copyAbsolutePath(viaClipboard)
    expect(viaClipboard.confirmCopied).toHaveBeenCalledOnce()

    const viaIpc = setup({ confirm: true, worktreePath: undefined })
    await copyAbsolutePath(viaIpc)
    expect(viaIpc.confirmCopied).toHaveBeenCalledOnce()
  })

  it('reports the IPC error and returns false when the fallback fails', async () => {
    const deps = setup({ confirm: true, worktreePath: undefined, copyViaIpc: vi.fn(() => Promise.resolve({ ok: false as const, error })) })
    expect(await copyAbsolutePath(deps)).toBe(false)
    expect(deps.notifyError).toHaveBeenCalledWith(error)
    expect(deps.confirmCopied).not.toHaveBeenCalled()
  })
})
