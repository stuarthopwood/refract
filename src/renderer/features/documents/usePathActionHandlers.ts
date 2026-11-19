import { useCallback } from 'react'
import { toast } from 'sonner'
import { notify, useSessionsStore } from '@/state'
import { copyAbsolutePath } from './copy-path'

/** Open in VS Code, Reveal and Copy path for one file of a Session, shared by the explorer and the file tab. */
export function usePathActionHandlers(sessionId: string | null) {
  const worktreePath = useSessionsStore((s) => s.sessions.find((session) => session.id === sessionId)?.worktreePath)

  const onOpenInVSCode = useCallback(
    async (path: string): Promise<boolean> => {
      if (!sessionId) return true
      const result = await window.refract.fileExplorer.openInVSCode(sessionId, path)
      if (!result.ok) {
        notify(result.error)
        return true
      }
      // `{ opened: false }` is a normal result, not an error: the preview header shows "VS Code not found" inline.
      return result.value.opened
    },
    [sessionId]
  )

  const onReveal = useCallback(
    async (path: string): Promise<void> => {
      if (!sessionId) return
      const result = await window.refract.fileExplorer.reveal(sessionId, path)
      if (!result.ok) notify(result.error)
    },
    [sessionId]
  )

  const onCopyPath = useCallback(
    (path: string, confirm = false): Promise<boolean> =>
      copyAbsolutePath({
        sessionId,
        worktreePath,
        path,
        confirm,
        writeClipboard: (text) => navigator.clipboard.writeText(text),
        copyViaIpc: (id, relativePath) => window.refract.fileExplorer.copyPath(id, relativePath),
        notifyError: notify,
        confirmCopied: () => toast.success('Path copied')
      }),
    [sessionId, worktreePath]
  )

  return { onOpenInVSCode, onReveal, onCopyPath }
}
