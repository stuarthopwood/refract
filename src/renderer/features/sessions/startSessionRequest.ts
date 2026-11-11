import { create } from 'zustand'
import { notifyPersistentError, useSplitStore, useViewStore } from '@/state'
import { createSessionFromItem, findExistingSession, type ItemRef } from './startSessionFromItem'
import type { Session } from '../../../shared/model'

type Pending = { kind: 'existing'; ref: ItemRef; existing: Session } | { kind: 'fork'; ref: ItemRef; owner: string | null }

interface StartSessionRequestState {
  pending: Pending | null
  clear(): void
}

export const useStartSessionRequestStore = create<StartSessionRequestState>((set) => ({
  pending: null,
  clear: () => set({ pending: null })
}))

/** Creates the Session and reports a failure as a toast. */
export async function startSessionNow(ref: ItemRef): Promise<void> {
  const message = await createSessionFromItem(ref)
  if (message) notifyPersistentError(message)
}

/** Entry point for every surface: asks first when an open Session already covers the item or the pull request is from a fork, else creates one. */
export async function requestSessionFromItem(ref: ItemRef): Promise<void> {
  const existing = findExistingSession(ref)
  if (existing) {
    useStartSessionRequestStore.setState({ pending: { kind: 'existing', ref, existing } })
    return
  }
  if (ref.kind === 'pull-request') {
    const detail = await window.refract.pullRequests.detail(ref.repositoryId, ref.number)
    // Fail closed: an unverifiable pull request gets the untrusted-code warning.
    if (!detail.ok || detail.value.isFork) {
      useStartSessionRequestStore.setState({ pending: { kind: 'fork', ref, owner: detail.ok ? (detail.value.headRepositoryOwner ?? null) : null } })
      return
    }
  }
  await startSessionNow(ref)
}

export function openExistingSession(session: Session): void {
  useSplitStore.getState().replaceFocused(session.id)
  useViewStore.getState().openChat()
}