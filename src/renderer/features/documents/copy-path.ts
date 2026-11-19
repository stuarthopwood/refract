import type { IpcError } from '../../../shared/ipc'
import { joinWorktreePath } from '../right-pane/file-explorer/tree-rows'

export interface CopyPathDeps {
  sessionId: string | null
  worktreePath: string | null | undefined
  path: string
  /** Show the "Path copied" toast; the menu item asks for it, the toolbar button does not. */
  confirm: boolean
  writeClipboard(text: string): Promise<void>
  copyViaIpc(sessionId: string, path: string): Promise<{ ok: true } | { ok: false; error: IpcError }>
  notifyError(error: IpcError): void
  confirmCopied(): void
}

/** Clipboard first for the absolute path, then the IPC copy when the clipboard throws or the worktree path is unknown. */
export async function copyAbsolutePath(deps: CopyPathDeps): Promise<boolean> {
  const { sessionId, worktreePath, path, confirm } = deps
  if (!sessionId) return false
  if (worktreePath) {
    try {
      await deps.writeClipboard(joinWorktreePath(worktreePath, path))
      if (confirm) deps.confirmCopied()
      return true
    } catch {
      // Fall through to the IPC copy below.
    }
  }
  const result = await deps.copyViaIpc(sessionId, path)
  if (result.ok && confirm) deps.confirmCopied()
  else if (!result.ok) deps.notifyError(result.error)
  return result.ok
}
