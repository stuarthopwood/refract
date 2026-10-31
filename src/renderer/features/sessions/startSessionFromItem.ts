import { toast } from 'sonner'
import { useDraftStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { Kickoff } from '../../../shared/ipc-issues'
import type { Session } from '../../../shared/model'

export interface ItemRef {
  kind: 'issue' | 'pull-request'
  repositoryId: string
  number: number
}

/** An open Session already started from this item: by `originIssue` for issues, by `pr-<n>` branch for pull requests. */
export function findExistingSession(ref: ItemRef): Session | undefined {
  const prBranch = new RegExp(`^pr-${ref.number}(-\\d+)?$`)
  return useSessionsStore.getState().sessions.find((session) => {
    if (session.repositoryId !== ref.repositoryId || session.archivedAt) return false
    return ref.kind === 'issue' ? session.originIssue?.number === ref.number : prBranch.test(session.branch)
  })
}

async function applyKickoff(sessionId: string, kickoff: Kickoff | null): Promise<void> {
  if (!kickoff) return
  if (kickoff.autoSend) {
    const sent = await window.refract.chat.send(sessionId, kickoff.prompt)
    if (sent.ok) return
  }
  const notice = kickoff.notice ?? 'The kickoff prompt could not be sent; it is in the composer.'
  useDraftStore.getState().setText(sessionId, kickoff.prompt)
  useDraftStore.getState().announceAttachment(sessionId, notice)
  toast.info(notice)
}

/** Creates the Session, switches to it, then sends or prefills the kickoff prompt. Resolves to an error message or null. */
export async function createSessionFromItem(ref: ItemRef): Promise<string | null> {
  const result =
    ref.kind === 'issue'
      ? await window.refract.issues.newSession(ref.repositoryId, ref.number)
      : await window.refract.pullRequests.newSessionFromPullRequest(ref.repositoryId, ref.number)
  if (!result.ok) return result.error.message
  await useSessionsStore.getState().refresh()
  useSplitStore.getState().replaceFocused(result.value.session.id)
  useViewStore.getState().openChat()
  await applyKickoff(result.value.session.id, result.value.kickoff)
  return null
}
