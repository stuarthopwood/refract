import { toast } from 'sonner'
import { notify } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'

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
  try {
   await navigator.clipboard.writeText(session.worktreePath)
   toast.success('Path copied')
   return
  } catch {
   // fall through to the main-process clipboard channel
  }
  const result = await window.refract.clipboard.writeText(session.worktreePath)
  if (result.ok) toast.success('Path copied')
  else notify(result.error)
 }

 async function reveal(): Promise<void> {
  const result = await window.refract.sessions.revealWorktree(session.id)
  if (!result.ok) notify(result.error)
 }

 return { copyPath, reveal }
}
