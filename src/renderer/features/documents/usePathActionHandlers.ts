import { useCallback } from 'react'
import { toast } from 'sonner'
import { notify, useSessionsStore } from '@/state'
import { joinWorktreePath } from '../right-pane/file-explorer/tree-rows'

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

  // Clipboard first for the absolute path, then the IPC fallback, as the explorer does.
  const onCopyPath = useCallback(
    async (path: string, confirm = false): Promise<boolean> => {
      if (!sessionId) return false
      if (worktreePath) {
        try {
          await navigator.clipboard.writeText(joinWorktreePath(worktreePath, path))
          if (confirm) toast.success('Path copied')
          return true
        } catch {
          // Fall through to the IPC copy below.
        }
      }
      const result = await window.refract.fileExplorer.copyPath(sessionId, path)
      if (result.ok && confirm) toast.success('Path copied')
      else if (!result.ok) notify(result.error)
      return result.ok
    },
    [sessionId, worktreePath]
  )

  return { onOpenInVSCode, onReveal, onCopyPath }
}
