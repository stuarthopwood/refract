import { toast } from 'sonner'
import { useRepositoriesStore, useSessionsStore, useSplitStore } from '@/state'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { focusSessionPane } from '@/lib/focus'
import { announceQuickCreateFallback } from './quickCreateFallback'
import { createdSessionAnnouncement } from './createdSessionAnnouncement'

/** Id of the Session in the focused pane (the only pane when not split), or null with no panes. */
export function focusedPaneSessionId(): string | null {
  const { paneSessionIds, focusedIndex } = useSplitStore.getState()
  if (paneSessionIds.length === 0) return null
  return paneSessionIds[Math.min(focusedIndex, paneSessionIds.length - 1)] ?? null
}

/** New session in the focused pane's repo (or the only repo); otherwise focuses the quick-create "+" rather than guess (#6). */
export function newSessionInFocusedPane(): void {
  const frontSessionId = focusedPaneSessionId()
  const currentSessions = useSessionsStore.getState().sessions
  const focusedSession = frontSessionId ? currentSessions.find((session) => session.id === frontSessionId) : undefined
  const repositories = useRepositoriesStore.getState().repositories
  const target = focusedSession
    ? repositories.find((candidate) => candidate.id === focusedSession.repositoryId)
    : repositories.length === 1
      ? repositories[0]
      : undefined
  const repository = target?.defaultBranch ? target : undefined

  if (!repository) {
    const plus = document.querySelector<HTMLElement>('[data-quick-create-session]')
    plus?.focus()
    if (document.activeElement !== plus) announceQuickCreateFallback()
    return
  }

  if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) return

  const origin = document.activeElement
  const originPaneContainer = origin?.closest('[data-session-pane]') ?? null

  // Announce immediately (worktree create takes seconds); a successful focus move stands in for a "created" announcement (#620).
  useChatAreaAnnouncer.getState().announce(`Creating session from ${repository.defaultBranch}`)
  void useSessionsStore
    .getState()
    .create(repository.id, repository.defaultBranch)
    .then((result) => {
      if (!result.ok) {
        toast.error(result.error.message, { duration: Infinity, closeButton: true })
        return
      }
      requestAnimationFrame(() => {
        const active = document.activeElement
        const stillHere =
          !active || active === document.body || !active.isConnected ||
          active === origin ||
          (originPaneContainer !== null && originPaneContainer.contains(active))
        if (!stillHere || !focusSessionPane(result.value.id)) {
          useChatAreaAnnouncer.getState().announce(createdSessionAnnouncement(result.value))
        }
      })
    })
    .catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err), { duration: Infinity, closeButton: true })
    })
}
