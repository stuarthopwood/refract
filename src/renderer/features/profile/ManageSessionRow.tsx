// One row in the Manage sessions screen (spec 008 FR-025): the shared Session row in its table
// layout (#934, ADR 0003), with this screen's own open, announce and focus behaviour supplied as a
// `SessionRowSurface`. The row, its actions and its menus are the sidebar list's own.
import { useMemo } from 'react'
import type { RefObject } from 'react'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { createdSessionAnnouncement, wasHiddenByFilter } from '@/features/sessions/createdSessionAnnouncement'
import { SessionRow } from '@/features/sessions/SessionRow'
import type { SessionRowSurface } from '@/features/sessions/sessionRowSurface'
import { focusSessionPane, focusSessionsNav } from '@/lib/focus'
import { useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'

export interface ManageSessionRowProps {
  session: SessionSummary
  // Issue #620, UX consult item 2 decision 5: the row's own repository, resolved by
  // `ManageSessionsScreen.tsx`. `undefined` in the same case `repositoryName` falls back to
  // "Unknown repository" -- the "New session from {branch}" item is then left out entirely, since
  // there is no repository to create into.
  repository: Repository | undefined
  repositoryName: string
  /** Falls back here when this row unmounts (archive/restore/delete) and neither a next nor a
   *  previous row survives -- the search input is the one control on this screen guaranteed to
   *  outlive every row, the same "always-connected" role `focusSessionsNav` plays for the sidebar. */
  searchInputRef: RefObject<HTMLInputElement | null>
  onAnnounce(message: string): void
}

// Focuses the FOCUSED pane's own content, read fresh after the split-store update has committed
// (never the clicked Session itself, which is wrong for a Ctrl+click into the unfocused pane).
function focusFocusedPane(): boolean {
  const { paneSessionIds, focusedIndex } = useSplitStore.getState()
  const focusedSessionId = paneSessionIds[focusedIndex]
  return !!focusedSessionId && focusSessionPane(focusedSessionId)
}

function openSession(sessionId: string, repositoryId: string, event: { ctrlKey: boolean; detail?: number }): void {
  // `openChat` swaps the WHOLE main area back to chat and unmounts this screen, so the sidebar row
  // that was underneath this row's position can end up under the pointer when a genuine second
  // click of a double-click lands. `event.detail` is 0 for a keyboard-triggered click and >= 1 for
  // a pointer click, so only a pointer activation arms this one-shot capture-phase guard: any
  // further click or dblclick within 500ms (the Windows default double-click time) is swallowed.
  if ((event.detail ?? 0) >= 1) {
    const swallow = (swallowed: Event) => {
      swallowed.stopPropagation()
      swallowed.preventDefault()
    }
    window.addEventListener('click', swallow, { capture: true })
    window.addEventListener('dblclick', swallow, { capture: true })
    setTimeout(() => {
      window.removeEventListener('click', swallow, { capture: true })
      window.removeEventListener('dblclick', swallow, { capture: true })
    }, 500)
  }
  const { paneSessionIds, focusedIndex, replaceFocused, openInSplit } = useSplitStore.getState()
  const index = paneSessionIds.indexOf(sessionId)
  const isFocusedPane = index !== -1 && (paneSessionIds.length < 2 || focusedIndex === index)
  if (event.ctrlKey) {
    openInSplit(sessionId)
  } else {
    replaceFocused(sessionId)
    if (isFocusedPane) void useSessionsStore.getState().open(sessionId)
  }
  useViewStore.getState().openChat(repositoryId)
  requestAnimationFrame(() => void focusFocusedPane())
}

export function ManageSessionRow({ session, repository, repositoryName, searchInputRef, onAnnounce }: ManageSessionRowProps) {
  const sessionId = session.id
  const repositoryId = session.repositoryId
  const surface = useMemo<SessionRowSurface>(
    () => ({
      fallbackFocus: () => searchInputRef.current?.focus(),
      announce: onAnnounce,
      open: (event) => openSession(sessionId, repositoryId, event),
      // On success, switches this screen back to chat and focuses the new Session's pane, but only
      // while this screen is still showing AND the user has not moved on (the multi-second checkout
      // may outlive both); otherwise the app-level announcer says "Created session {name}".
      created: (created, { isStillHere }) => {
        const announcement = createdSessionAnnouncement(created)
        if (!(useViewStore.getState().view === 'manage-sessions' && isStillHere())) {
          useChatAreaAnnouncer.getState().announce(announcement)
          return
        }
        useViewStore.getState().openChat(created.repositoryId)
        requestAnimationFrame(() => {
          const found = focusFocusedPane()
          // A found pane still needs the announcement when the new row is hidden by the filter.
          if (!found || wasHiddenByFilter(announcement)) useChatAreaAnnouncer.getState().announce(announcement)
          if (!found) focusSessionsNav()
        })
      }
    }),
    [sessionId, repositoryId, searchInputRef, onAnnounce]
  )
  return <SessionRow layout="table" session={session} repository={repository} projectName={repositoryName} surface={surface} />
}
