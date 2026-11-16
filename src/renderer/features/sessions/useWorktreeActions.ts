import { toast } from 'sonner'
import { notify } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import { isProjectSession } from '../../../shared/model'

/** Copy-path and reveal-in-file-explorer actions shared between the session details card
 * (`SessionDetailsCard.tsx`) and the row's `DropdownMenu` (T069: both expose the same two
 * actions, since Radix hover cards are not keyboard-reachable). */
export function useWorktreeActions(session: SessionSummary): {
  copyPath: () => Promise<void>
  reveal: () => Promise<void>
} {
  // T069: tries the renderer's own Clipboard API first; the sandboxed renderer denies every
  // permission request/check (`src/main/index.ts`), so that throws here and this falls back to
  // the allowlisted main-process clipboard channel instead.
  async function copyPath(): Promise<void> {
    // A Personal Agent has no worktree; its menus do not offer this action.
    if (!isProjectSession(session)) return
    const path = session.worktreePath
    try {
      await navigator.clipboard.writeText(path)
      toast.success('Path copied')
      return
    } catch {
      // fall through to the main-process clipboard channel
    }
    const result = await window.refract.clipboard.writeText(path)
    if (result.ok) toast.success('Path copied')
    else notify(result.error)
  }

  async function reveal(): Promise<void> {
    if (!isProjectSession(session)) return
    const result = await window.refract.sessions.revealWorktree(session.id)
    if (!result.ok) notify(result.error)
  }

  return { copyPath, reveal }
}
