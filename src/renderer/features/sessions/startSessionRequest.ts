import { create } from 'zustand'
import { toast } from 'sonner'
import { useSplitStore, useViewStore } from '@/state'
import { createSessionFromItem, findExistingSession, type ItemRef } from './startSessionFromItem'
import type { Session } from '../../../shared/model'

interface Pending {
  ref: ItemRef
  existing: Session
}

interface StartSessionRequestState {
  pending: Pending | null
  clear(): void
}

export const useStartSessionRequestStore = create<StartSessionRequestState>((set) => ({
  pending: null,
  clear: () => set({ pending: null })
}))

/** Entry point for every surface: asks first when an open Session already covers the item, else creates one. */
export async function requestSessionFromItem(ref: ItemRef): Promise<void> {
  const existing = findExistingSession(ref)
  if (existing) {
    useStartSessionRequestStore.setState({ pending: { ref, existing } })
    return
  }
  const message = await createSessionFromItem(ref)
  if (message) toast.error(message, { duration: Infinity, closeButton: true })
}

export function openExistingSession(session: Session): void {
  useSplitStore.getState().replaceFocused(session.id)
  useViewStore.getState().openChat()
}
