import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { notify, useSessionsStore, useSplitStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { buildSessionRowActions } from './sessionActions'
import type { SessionRowAction } from './sessionActions'
import { useWorktreeActions } from './useWorktreeActions'
import { useSessionResume } from './useSessionResume'
import { focusSessionPane, focusSessionRow, focusSessionsNav } from '@/lib/focus'
import { useFocusSearchOnStrandedUnmount } from './useFocusSearchOnStrandedUnmount'
import { createdSessionAnnouncement } from './createdSessionAnnouncement'
import { useHideSession } from './useHideSession'
import { useSurfaceArchiveActions } from './sessionRowSurface'
import type { SessionRowSurface } from './sessionRowSurface'
import { setSessionPaused } from '@/features/chat/pauseActions'
import { setPrewalk } from './prewalkActions'
import { usePrewalkStore } from '@/state/prewalk-store'

export function useSessionRowActions(session: SessionSummary, repository: Repository | undefined, surface?: SessionRowSurface) {
  const isVisible = useSplitStore((state) => state.paneSessionIds.includes(session.id))
  const isFocusedPane = useSplitStore((state) => {
    const index = state.paneSessionIds.indexOf(session.id)
    return index !== -1 && (state.paneSessionIds.length < 2 || state.focusedIndex === index)
  })
  // Lets assistive tech tell which of the two aria-current rows a plain click targets.
  const isSplitOpen = useSplitStore((state) => state.paneSessionIds.length === 2)
  const replaceFocused = useSplitStore((state) => state.replaceFocused)
  const openInSplit = useSplitStore((state) => state.openInSplit)
  const open = useSessionsStore((state) => state.open)
  const createSession = useSessionsStore((state) => state.create)
  // A derived boolean, not the whole Set, so one repository's create doesn't re-render every row.
  const creatingThisRepository = useSessionsStore((state) => (repository ? state.creatingRepositoryIds.has(repository.id) : false))
  const rename = useSessionsStore((state) => state.rename)
  const archive = useSessionsStore((state) => state.archive)
  const restore = useSessionsStore((state) => state.restore)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  // A derived boolean, not the whole Set, so one deleting Session doesn't re-render every row.
  const deleting = useSessionsStore((state) => state.deletingIds.has(session.id))
  const prewalkState = usePrewalkStore((s) => s.bySession[session.id] ?? 'unknown')
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { copyPath, reveal } = useWorktreeActions(session)
  const worktreeMissing = session.stopReason === 'worktree-missing'
  const rowRef = useRef<HTMLLIElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameRequestedRef = useRef(false)
  const restoreFocusRef = useRef(false)
  // Set in `onNewSession`'s `onSelect` so menu-close focus handling skips Radix's return-to-trigger;
  // the create's own settle handler decides where focus goes.
  const createRequestedRef = useRef(false)
  // Set when either menu opens, not at close: a fast create can settle before the close animation ends.
  const createOriginRef = useRef<'dropdown' | 'context' | null>(null)
  // The in-row element focused when a context menu opened (e.g. Shift+F10 on the "..." trigger).
  const contextMenuOpenerRef = useRef<HTMLElement | null>(null)
  // The modal menu keeps `#root` aria-hidden while closing, so an announcement made in `onSelect`
  // is lost; held here, flushed once the menu closes, via the app-level chatAreaAnnouncer (#621).
  const pendingCreateAnnouncementRef = useRef<string | null>(null)
  // A create that settles mid close-animation stashes its finish here; `handleMenuCloseAutoFocus` runs it after unmount.
  const settledCreateRef = useRef<(() => void) | null>(null)
  // Same pattern for a restore that settles while `restoreRequestedRef` is still true (#527).
  const settledRestoreRef = useRef<(() => void) | null>(null)
  // Archive/restore/delete unmount the row (sometimes its whole group) asynchronously, so focus
  // targets are captured while mounted as a chain of fallback elements resolved lazily by
  // `isConnected`, ending at the Sessions nav root, which outlives every row.
  // Set in `onRestore`'s `onSelect` so menu close parks focus on the fallback; `restoreParkedRef`
  // records where, so the later `.then` can tell a deliberate user move from focus still parked.
  const restoreRequestedRef = useRef(false)
  const restoreParkedRef = useRef<HTMLElement | null>(null)
  const fallbackFocus = surface?.fallbackFocus ?? focusSessionsNav
  const focusFallbackRef = useRef<() => void>(fallbackFocus)

  // Captures the next still-connected place for focus to land after this row unmounts.
  function captureFocusFallback(): void {
    const li = rowRef.current
    const nextButton =
      (li?.nextElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.session-open-button, .manage-session-open-button') ?? null
    const prevButton =
      (li?.previousElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.session-open-button, .manage-session-open-button') ??
      null
    const groupRoot = li?.closest<HTMLElement>('[data-repository-id], [data-archived-group]') ?? null
    const trigger = groupRoot?.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]') ?? null
    focusFallbackRef.current = () => {
      if (nextButton?.isConnected) nextButton.focus()
      else if (prevButton?.isConnected) prevButton.focus()
      else if (trigger?.isConnected) trigger.focus()
      else fallbackFocus()
    }
  }

  // After a row unmounts (archive/restore/delete), focus must not fall back to <body>
  // (WCAG 2.1 AA focus-visibility): send it to the captured fallback.
  function focusListContainer(): void {
    focusFallbackRef.current()
  }

  function startRenaming(): void {
    setDraftName(session.name)
    setRenaming(true)
  }

  const { resuming, resumeButtonRef, canResume, handleResume } = useSessionResume(session, openButtonRef, focusListContainer)

  async function commitRename(): Promise<void> {
    const name = draftName.trim()
    setRenaming(false)
    if (name && name !== session.name) await rename(session.id, name)
    else setDraftName(session.name)
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation()
    if (event.key === 'Enter') {
      restoreFocusRef.current = true
      void commitRename()
    }
    if (event.key === 'Escape') {
      restoreFocusRef.current = true
      setDraftName(session.name)
      setRenaming(false)
    }
  }

  function handleOpenButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    // Only F2 is claimed; every other key (Tab, arrows) must keep navigating while the row is deleting.
    if (event.key !== 'F2') return
    event.preventDefault()
    if (!deleting) startRenaming()
  }

  // The row's actions unmount when it starts deleting. Subscribing (not an effect on `deleting`) lets
  // this run before that commit, while the focused control is still in the DOM.
  useEffect(
    () =>
      useSessionsStore.subscribe((state, prev) => {
        if (state.deletingIds === prev.deletingIds) return
        if (!state.deletingIds.has(session.id) || prev.deletingIds.has(session.id)) return
        const active = document.activeElement
        if (active && active !== openButtonRef.current && rowRef.current?.contains(active)) openButtonRef.current?.focus()
      }),
    [session.id]
  )

  // `autoFocus` alone loses to Radix's post-paint dropdown-close focus restore (lands on <body>);
  // deferring one frame makes this the last mover (WCAG 2.1 AA).
  useEffect(() => {
    if (!renaming) return
    const raf = requestAnimationFrame(() => renameInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [renaming])

  // Enter/Escape swap the focused rename input for the open button; refocus only when armed, so
  // a blur-triggered commit doesn't steal focus back.
  useEffect(() => {
    if (renaming) return
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    openButtonRef.current?.focus()
  }, [renaming])

  // Shared with `RepositoryGroup.tsx`; skips its redirect while this row's restore is in flight (`onRestore` has its own fallback).
  useFocusSearchOnStrandedUnmount(rowRef, restoreRequestedRef, !surface)

  // A row on another screen (`surface`) has no sidebar search to fall back to: when this
  // instance is torn down (archive, restore and delete only sometimes unmount it) with focus
  // stranded, send it to the fallback captured while the row was still mounted (WCAG 2.4.3).
  useEffect(() => {
    if (!surface) return
    return () => {
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) focusFallbackRef.current()
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Creates instantly in this row's repository and default branch; on success focuses the new
  // pane one frame later, only if the user hasn't moved on. The failure toast always shows
  // and stays until dismissed.
  function handleNewSession(): void {
    if (!repository) return
    createRequestedRef.current = true
    pendingCreateAnnouncementRef.current = `Creating session from ${repository.defaultBranch}`
    const row = rowRef.current
    function isStillHere(): boolean {
      const active = document.activeElement
      const origin = createOriginRef.current === 'context' ? (contextMenuOpenerRef.current ?? openButtonRef.current) : menuTriggerRef.current
      return !active || active === document.body || !active.isConnected || active === origin || (row?.contains(active) ?? false)
    }
    function focusOrigin(): void {
      const origin = createOriginRef.current === 'context' ? (contextMenuOpenerRef.current ?? openButtonRef.current) : menuTriggerRef.current
      if (origin?.isConnected) origin.focus()
      else if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
      else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
      else focusListContainer()
    }
    // If the menu is still closing, stash `finish` for `handleMenuCloseAutoFocus` to run after unmount.
    function restoreAfterCreateFailure(message: string): void {
      pendingCreateAnnouncementRef.current = null
      const finish = () => {
        toast.error(message, { duration: Infinity, closeButton: true })
        if (isStillHere()) focusOrigin()
      }
      if (createRequestedRef.current) settledCreateRef.current = finish
      else finish()
    }
    void createSession(repository.id, repository.defaultBranch)
      .then((result) => {
        pendingCreateAnnouncementRef.current = null
        if (!result.ok) {
          restoreAfterCreateFailure(result.error.message)
          return
        }
        const finish = surface ? () => surface.created(result.value, { isStillHere, focusOrigin }) : () => {
          requestAnimationFrame(() => {
            // `focusSessionPane` can find no pane (view switched, split closed); announce, and if
            // the user is still here also focus the origin so focus never strands on <body>.
            const here = isStillHere()
            if (!(here && focusSessionPane(result.value.id))) {
              useChatAreaAnnouncer.getState().announce(createdSessionAnnouncement(result.value))
              if (here) focusOrigin()
            }
          })
        }
        if (createRequestedRef.current) settledCreateRef.current = finish
        else finish()
      })
      .catch((err) => restoreAfterCreateFailure(err instanceof Error ? err.message : String(err)))
  }

  // The "..." menu and right-click context menu share one action list (sessionActions.ts, shared
  // with ManageSessionRow.tsx); only the side effects below stay local.
  const hideSession = useHideSession(session, {
    captureFocusFallback,
    focusRow: () => menuTriggerRef.current?.focus(),
    ...(surface ? { onAnnounce: surface.announce, focusAfterUnhide: () => openButtonRef.current?.focus() } : {})
  })
  const surfaceArchive = useSurfaceArchiveActions(session, surface, captureFocusFallback)
  const actions: SessionRowAction[] = buildSessionRowActions(
    session,
    {
      onNewSession: handleNewSession,
      onRename: () => {
        renameRequestedRef.current = true
        startRenaming()
      },
      onOpenInSplit: surface ? () => surface.open({ ctrlKey: true }) : () => openInSplit(session.id),
      onCopyPath: () => void copyPath(),
      onReveal: () => void reveal(),
      // Focus moves to the list only on archive success: a refused archive keeps the row, and
      // `archive()` can take seconds, so only move focus if it is stranded or still inside this row.
      onArchive: surface ? surfaceArchive.onArchive : () => {
        captureFocusFallback()
        const row = rowRef.current
        void archive(session.id)
          .then((ok) => {
            if (!ok) return
            const active = document.activeElement
            if (!active || active === document.body || !active.isConnected || row?.contains(active)) focusListContainer()
          })
          .catch((err) => notify({ code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) }))
      },
      // On success, focus the restored row (#621) unless the user has moved on meanwhile.
      onRestore: surface ? surfaceArchive.onRestore : () => {
        restoreRequestedRef.current = true
        // Clear a stale value from an earlier restore; `isStillHere` reads it.
        restoreParkedRef.current = null
        captureFocusFallback()
        const row = rowRef.current
        const origin = createOriginRef.current === 'context' ? (contextMenuOpenerRef.current ?? openButtonRef.current) : menuTriggerRef.current
        function isStillHere(): boolean {
          const active = document.activeElement
          return (
            !active ||
            active === document.body ||
            !active.isConnected ||
            active === origin ||
            active === restoreParkedRef.current ||
            (row?.contains(active) ?? false)
          )
        }
        void restore(session.id)
          .then((ok) => {
            if (!ok) {
              // A refusal can settle before focus was parked, so use the broad `isStillHere()`
              // check rather than an exact match against the parked element.
              const finish = () => {
                if (!isStillHere()) return
                if (origin?.isConnected) origin.focus()
                else focusListContainer()
              }
              if (restoreRequestedRef.current) settledRestoreRef.current = finish
              else finish()
              return
            }
            const finish = () => {
              requestAnimationFrame(() => {
                if (!isStillHere()) return
                if (focusSessionRow(session.id)) return
                // The restored row's group may be collapsed: fall back to its header trigger,
                // then the generic fallback, and announce since nothing visibly got focus.
                const groupTrigger = document.querySelector<HTMLElement>(
                  `[data-repository-id="${CSS.escape(session.repositoryId)}"] [data-slot="collapsible-trigger"]`
                )
                if (groupTrigger?.isConnected) groupTrigger.focus()
                else focusListContainer()
                useChatAreaAnnouncer.getState().announce(`Restored ${session.name}`)
              })
            }
            function settleOrRun(): void {
              if (restoreRequestedRef.current) settledRestoreRef.current = finish
              else finish()
            }
            // restore() resolving only means main wrote the registry; wait for the sessions store's
            // own refresh to show the Session unarchived before moving focus.
            if (!useSessionsStore.getState().sessions.find((s) => s.id === session.id)?.archivedAt) {
              settleOrRun()
              return
            }
            const unsubscribe = useSessionsStore.subscribe((state) => {
              if (state.sessions.find((s) => s.id === session.id)?.archivedAt) return
              unsubscribe()
              settleOrRun()
            })
            // Stop waiting if the store never reflects the restore (missed event, deleted or re-archived).
            window.setTimeout(unsubscribe, 5000)
          })
          .catch((err) => notify({ code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) }))
      },
      onHide: hideSession.hide,
      onUnhide: hideSession.unhide,
      onStopAgent: () => void stopAgent(session.id),
      onTogglePause: () => void setSessionPaused(session.id, !session.pause),
      prewalk: { state: prewalkState, onToggle: () => void setPrewalk(session.id, prewalkState !== 'armed') },
      onDelete: () => {
        captureFocusFallback()
        setDeleteOpen(true)
      }
    },
    // A repository whose git read failed has no default branch: omit the item rather than create on "".
    repository?.defaultBranch ? { branch: repository.defaultBranch, disabled: creatingThisRepository } : null,
    deleting
  )

  // `isContextMenu`: the context menu opens from the row's open button, so close-autofocus returns there, not to "...".
  function handleMenuCloseAutoFocus(event: Event, isContextMenu = false): void {
    surfaceArchive.flushPendingAnnouncement()
    if (renameRequestedRef.current) {
      event.preventDefault()
      renameRequestedRef.current = false
    } else if (restoreRequestedRef.current) {
      event.preventDefault()
      restoreRequestedRef.current = false
      const settledRestore = settledRestoreRef.current
      settledRestoreRef.current = null
      if (settledRestore) {
        settledRestore()
      } else {
        const origin = isContextMenu ? (contextMenuOpenerRef.current ?? openButtonRef.current) : menuTriggerRef.current
        if (origin?.isConnected) origin.focus()
        else if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
        else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
        else focusListContainer()
        restoreParkedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
    } else if (createRequestedRef.current) {
      // Park focus on the menu's origin instead of leaving it on <body> for the checkout (WCAG 2.4.3).
      // `createOriginRef` is set at menu open so a fast create still reads the right one. Also
      // flushes the held announcement, as `#root`'s aria-hidden has lifted by now.
      event.preventDefault()
      createRequestedRef.current = false
      if (pendingCreateAnnouncementRef.current) {
        useChatAreaAnnouncer.getState().announce(pendingCreateAnnouncementRef.current)
        pendingCreateAnnouncementRef.current = null
      }
      // Run a create stashed while the menu was closing; only park focus when nothing was
      // stashed, or a finished create's focus move would be stolen back.
      const settled = settledCreateRef.current
      settledCreateRef.current = null
      if (settled) {
        settled()
      } else if (repository && useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) {
        const origin = isContextMenu ? (contextMenuOpenerRef.current ?? openButtonRef.current) : menuTriggerRef.current
        if (origin?.isConnected) origin.focus()
        else if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
        else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
        else focusListContainer()
      }
    } else {
      // The context menu's trigger is the non-focusable row <div>, so Radix cannot return focus
      // there and it would fall to <body> (WCAG 2.1 AA); redirect to the row's focusable elements.
      event.preventDefault()
      if (isContextMenu) {
        const target = contextMenuOpenerRef.current?.isConnected ? contextMenuOpenerRef.current : openButtonRef.current
        if (target?.isConnected) target.focus()
        else if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
        else focusListContainer()
      } else if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
      else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
      else focusListContainer()
    }
  }

  return {
    isVisible, isFocusedPane, isSplitOpen, replaceFocused, openInSplit, open, deleting,
    renaming, draftName, setDraftName, deleteOpen, setDeleteOpen, resuming,
    resumeButtonRef, worktreeMissing, rowRef, openButtonRef, menuTriggerRef, renameInputRef,
    createRequestedRef, createOriginRef, contextMenuOpenerRef,
    settledCreateRef, settledRestoreRef, restoreRequestedRef,
    focusListContainer, startRenaming, canResume, handleResume,
    commitRename, handleNameKeyDown, handleOpenButtonKeyDown,
    actions, handleMenuCloseAutoFocus,
    quickActionPending: surfaceArchive.quickActionPending, runQuickAction: surfaceArchive.runQuickAction
  }
}
