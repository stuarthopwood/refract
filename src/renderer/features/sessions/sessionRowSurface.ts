import { useRef, useState } from 'react'
import { useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Session } from '../../../shared/model'

/** Callbacks a screen other than the sidebar Session list supplies when it renders the shared
 *  `SessionRow` (#934: Manage sessions). Everything not listed here (rename, delete, menus,
 *  Resume, hide) is the row's own, identical on both screens. */
export interface SessionRowSurface {
  /** The last-resort focus target once no neighbouring row survives (the sidebar's is its nav). */
  fallbackFocus(): void
  /** Polite live-region message for an archive, restore or hide outcome. */
  announce(message: string): void
  /** An open request: plain click or Enter, Ctrl+click, or the "Open in split" menu item. */
  open(event: { ctrlKey: boolean; detail?: number }): void
  /** A New session create succeeded; `isStillHere` and `focusOrigin` let it respect where focus is. */
  created(created: Session, ctx: { isStillHere(): boolean; focusOrigin(): void }): void
}

/** Archive and restore for a row on a `SessionRowSurface`: focus fallback, an announcement held
 *  until a menu has finished closing (Radix keeps `#root` aria-hidden through the animation, WCAG
 *  4.1.3), and the always-visible Archive/Restore quick action with its in-flight guard. */
export function useSurfaceArchiveActions(
  session: SessionSummary,
  surface: SessionRowSurface | undefined,
  captureFocusFallback: () => void
) {
  const archive = useSessionsStore((state) => state.archive)
  const restore = useSessionsStore((state) => state.restore)
  const [quickActionPending, setQuickActionPending] = useState(false)
  const quickActionPendingRef = useRef(false)
  const deferAnnouncementRef = useRef(false)
  const pendingAnnouncementRef = useRef<string | null>(null)

  function fromMenu(run: (id: string) => Promise<boolean>, verb: string): void {
    captureFocusFallback()
    deferAnnouncementRef.current = true
    void run(session.id).then((ok) => {
      if (!ok) return
      const message = `${verb} ${session.name}`
      if (deferAnnouncementRef.current) pendingAnnouncementRef.current = message
      else surface?.announce(message)
    })
  }

  // Called first in the menu's close-autofocus: releases a held archive/restore announcement.
  function flushPendingAnnouncement(): void {
    deferAnnouncementRef.current = false
    if (!pendingAnnouncementRef.current) return
    surface?.announce(pendingAnnouncementRef.current)
    pendingAnnouncementRef.current = null
  }

  // `aria-disabled`, not `disabled`, with a ref guard: blocks a double click before React
  // re-renders without ever moving keyboard focus off the button mid-action.
  function runQuickAction(): void {
    if (quickActionPendingRef.current) return
    quickActionPendingRef.current = true
    setQuickActionPending(true)
    captureFocusFallback()
    const wasArchived = !!session.archivedAt
    void (wasArchived ? restore(session.id) : archive(session.id)).then((ok) => {
      quickActionPendingRef.current = false
      setQuickActionPending(false)
      // The store already reported a failure through its own toast; never announce success next to it.
      if (ok) surface?.announce(`${wasArchived ? 'Restored' : 'Archived'} ${session.name}`)
    })
  }

  return {
    onArchive: () => fromMenu(archive, 'Archived'),
    onRestore: () => fromMenu(restore, 'Restored'),
    flushPendingAnnouncement,
    quickActionPending,
    runQuickAction
  }
}
