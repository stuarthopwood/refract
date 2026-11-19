import type { ReactNode } from 'react'
import { ArchiveParentDialog } from '@/features/sessions/ArchiveParentDialog'
import { useArchiveSession } from '@/features/sessions/useArchiveSession'
import { notify } from '@/state'
import { useChatAreaAnnouncer } from './chatAreaAnnouncer'

// Kept out of ChatPane, which is over the file-size cap and must not grow (#1862). A Session with live
// children asks first; any other archives at once.
export function useChatArchive(sessionId: string): { archive(): Promise<void>; dialog: ReactNode } {
  const archiveParent = useArchiveSession(sessionId, {
    announce: (message) => useChatAreaAnnouncer.getState().announce(message),
    onClosed: () => false
  })

  async function archive(): Promise<void> {
    if (archiveParent.request()) return
    const result = await window.refract.sessions.archive(sessionId)
    if (!result.ok) notify(result.error)
  }

  return { archive, dialog: <ArchiveParentDialog controls={archiveParent.controls} /> }
}
