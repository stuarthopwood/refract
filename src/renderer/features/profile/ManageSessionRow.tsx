// One row in the Manage sessions screen (spec 008 FR-025, T026): a flat, cross-repository
// scanning row (visible status word, repository name, last activity), distinct from
// SessionList.tsx's own repository-grouped row -- but offering the IDENTICAL action set through
// the IDENTICAL shared list (sessionActions.ts), never a second hand-maintained menu. The
// primary "open" button covers only the info area; the quick action and "..." menu are its
// SIBLINGS, never nested inside it (a button must never contain another button).
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { toast } from 'sonner'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisVerticalIcon,
  FolderGit2Icon,
  GitBranchIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { buildSessionRowActions } from '@/features/sessions/sessionActions'
import { STATUS_LABEL, StateIcon, displayStatus, formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { useWorktreeActions } from '@/features/sessions/useWorktreeActions'
import { focusSessionPane, focusSessionsNav } from '@/lib/focus'
import { useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'

export interface ManageSessionRowProps {
  session: SessionSummary
  // Issue #620, UX consult item 2 decision 5: the row's own repository, resolved by
  // `ManageSessionsScreen.tsx` (which already reads `useRepositoriesStore`). `undefined` in the
  // same case `repositoryName` already falls back to "Unknown repository" -- the "New session
  // from {branch}" item is left out of the shared builder entirely in that case, since there is
  // no repository to create into.
  repository: Repository | undefined
  repositoryName: string
  /** Falls back here when this row unmounts (archive/restore/delete) and neither a next nor a
   *  previous row survives -- the search input is the one control on this screen guaranteed to
   *  outlive every row, the same "always-connected" role `focusSessionsNav` plays for
   *  SessionList.tsx (src/renderer/lib/focus.ts). */
  searchInputRef: RefObject<HTMLInputElement | null>
  onAnnounce(message: string): void
}

export function ManageSessionRow({ session, repository, repositoryName, searchInputRef, onAnnounce }: ManageSessionRowProps) {
  const isVisible = useSplitStore((state) => state.paneSessionIds.includes(session.id))
  const isFocusedPane = useSplitStore((state) => {
    const index = state.paneSessionIds.indexOf(session.id)
    return index !== -1 && (state.paneSessionIds.length < 2 || state.focusedIndex === index)
  })
  const replaceFocused = useSplitStore((state) => state.replaceFocused)
  const openInSplit = useSplitStore((state) => state.openInSplit)
  const open = useSessionsStore((state) => state.open)
  const createSession = useSessionsStore((state) => state.create)
  // Code-review fix (gate round 1): subscribes to a derived boolean, not the whole Set, so a
  // create for one repository does not re-render every OTHER row.
  const creatingThisRepository = useSessionsStore((state) => (repository ? state.creatingRepositoryIds.has(repository.id) : false))
  const rename = useSessionsStore((state) => state.rename)
  const archive = useSessionsStore((state) => state.archive)
  const restore = useSessionsStore((state) => state.restore)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [quickActionPending, setQuickActionPending] = useState(false)
  const { copyPath, reveal } = useWorktreeActions(session)
  const isArchived = !!session.archivedAt
  const worktreeMissing = session.stopReason === 'worktree-missing'
  const rowRef = useRef<HTMLLIElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameRequestedRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const quickActionPendingRef = useRef(false)
  // Issue #620, UX consult item 2 decision 8: mirrors `SessionList.tsx`'s own guard -- set
  // synchronously in `onNewSession`'s `onSelect` so `handleMenuCloseAutoFocus` knows to
  // `preventDefault` Radix's own return-to-trigger (there is nothing to focus yet at menu-close
  // time; the create's own then-handler decides once it settles).
  const createRequestedRef = useRef(false)
  // Code-review fix (gate round 2): set synchronously when either menu OPENS (see the
  // `DropdownMenu`/`ContextMenu` `onOpenChange` below), not at close time -- a fast create that
  // settles before the menu's own close animation finishes used to read this back as `null`.
  const createOriginRef = useRef<'dropdown' | 'context' | null>(null)
  // A11y-review fix (gate round 2, LOW): the element that actually had focus when a right-click/
  // Shift+F10 context menu opened, when that element is inside this row -- a closer match than
  // always falling back to the open button.
  const contextMenuOpenerRef = useRef<HTMLElement | null>(null)
  // Post-build review fix (accessibility-auditor, Medium, WCAG 4.1.3): archive/restore chosen
  // from the "..." menu or the right-click context menu, below, must not announce until the
  // menu's close animation actually finishes -- see `handleMenuCloseAutoFocus`.
  const deferAnnouncementRef = useRef(false)
  const pendingAnnouncementRef = useRef<string | null>(null)
  // A11y-review fix (gate round 2, WCAG 4.1.3): kept separate from `pendingAnnouncementRef`
  // above (archive/restore's own region, which can be unmounted mid-create by a view swap) --
  // flushed through the app-level `useChatAreaAnnouncer` instead (#621's shared announcer),
  // which survives this screen unmounting if the developer navigates elsewhere while the
  // create's worktree checkout runs (gate round 2 High).
  const pendingCreateAnnouncementRef = useRef<string | null>(null)
  // Code-review fix (gate round 3, High): if `create()` settles DURING the menu's own close
  // animation (focus is still on the now-portalled menu item, `#root` is still `aria-hidden`),
  // `isStillHere()` always reads false and the toast/announcement can be added while hidden --
  // deferred here instead: `handleNewSession`'s own settle handler stashes itself when
  // `createRequestedRef` is still true, and `handleMenuCloseAutoFocus`'s `createRequestedRef`
  // branch runs it once the content has actually unmounted and `aria-hidden` has lifted.
  const settledCreateRef = useRef<(() => void) | null>(null)
  // Same fallback-CHAIN idea as SessionList.tsx's own `captureFocusFallback` (its own doc
  // comment explains why a plain `closest` captured once is not enough): next row, else
  // previous row, else the search input, resolved lazily against `isConnected` so it never
  // fires against an element this same unmount already took with it.
  const focusFallbackRef = useRef<() => void>(() => searchInputRef.current?.focus())

  // Post-build review fix (Phase7PostBuild, HIGH, WCAG 2.4.3): archive/restore/delete only
  // SOMETIMES unmount this row (under the Active/Archived filter they do; under All, archive and
  // restore never do -- the row survives with its quick-action button simply relabelled, and the
  // browser keeps focus on that same DOM node with no code needed). The previous version armed a
  // 3-second timer after each action and only ran the fallback if it was still armed when THIS
  // instance unmounted -- any row's unrelated quick action within that 3s window disarmed it, so
  // confirming a delete dialog read for longer than 3 seconds (the normal case for a dialog
  // listing data loss) dropped focus to `<body>` with nothing left to catch it. The unmount
  // itself is the only signal this needs: whenever this instance is actually torn down, if focus
  // has nowhere left to go (null or `<body>`), send it to the fallback captured while the row was
  // still mounted.
  useEffect(() => {
    return () => {
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) focusFallbackRef.current()
      })
    }
  }, [])

  function captureFocusFallback(): void {
    const li = rowRef.current
    const nextButton =
      (li?.nextElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.manage-session-open-button') ?? null
    const prevButton =
      (li?.previousElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.manage-session-open-button') ?? null
    focusFallbackRef.current = () => {
      if (nextButton?.isConnected) nextButton.focus()
      else if (prevButton?.isConnected) prevButton.focus()
      else searchInputRef.current?.focus()
    }
  }

  function focusListContainer(): void {
    focusFallbackRef.current()
  }

  function startRenaming(): void {
    setDraftName(session.name)
    setRenaming(true)
  }

  async function commitRename(): Promise<void> {
    const trimmed = draftName.trim()
    setRenaming(false)
    if (trimmed && trimmed !== session.name) await rename(session.id, trimmed)
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

  // Shared with SessionList.tsx's own row (DESIGN.md "Session list keyboard and focus model"):
  // F2 starts a rename from the open button the same way it does from the nav row, so the same
  // object behaves identically on both screens.
  function handleOpenButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'F2') {
      event.preventDefault()
      startRenaming()
    }
  }

  useEffect(() => {
    if (!renaming) return
    const raf = requestAnimationFrame(() => renameInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [renaming])

  useEffect(() => {
    if (renaming) return
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    openButtonRef.current?.focus()
  }, [renaming])

  // Mirrors SessionList.tsx's own row-click rule exactly (replaceFocused / openInSplit / the
  // isFocusedPane wake-check), with two additions: this screen is not the chat view, so every
  // path also switches back to it (FR-025's own "opens that session" requirement), and a real
  // pointer click is guarded against the double-click fall-through below.
  function handleOpen(event: { ctrlKey: boolean; detail?: number }): void {
    // Post-build review fix (Phase7PostBuild, HIGH): `openChat` below swaps the WHOLE main area
    // back to chat and unmounts this screen -- the left nav row that was always underneath this
    // row's own position can end up under the pointer by the time a genuine second click of a
    // double-click lands, opening (or renaming) whatever Session that nav row happens to show
    // instead of this one. `event.detail` is 0 for a keyboard-triggered click (Enter/Space) and
    // >= 1 for a real pointer click, so only a pointer activation arms this one-shot
    // capture-phase guard: any further `click`/`dblclick` anywhere in the document within the
    // next 500ms (the Windows default double-click time) is swallowed before it can reach that
    // nav row.
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
    if (event.ctrlKey) {
      openInSplit(session.id)
    } else {
      replaceFocused(session.id)
      if (isFocusedPane) void open(session.id)
    }
    useViewStore.getState().openChat(session.repositoryId)
    // Post-build review fix (D2/Phase7PostBuild, HIGH): this screen unmounts the instant the view
    // flips back to chat (App.tsx swaps the whole main area on `view`), unlike SessionList.tsx's
    // own row click, which never unmounts anything -- there is no single "the clicked row" to
    // leave focus on here. Reads the FOCUSED pane's Session id fresh, after the split-store
    // update above has committed (never `session.id` itself, which is wrong for a Ctrl+click into
    // the unfocused pane), and focuses that pane's own content -- never the first enabled
    // textarea anywhere in the document (wrong pane in a split, `<body>` for a stopped Session).
    requestAnimationFrame(() => {
      const { paneSessionIds, focusedIndex } = useSplitStore.getState()
      const focusedSessionId = paneSessionIds[focusedIndex]
      if (focusedSessionId) focusSessionPane(focusedSessionId)
    })
  }

  // Post-build review fix (Phase7PostBuild, Low): blocks a second click before React re-renders
  // (a double-click on the quick action itself), the same `aria-disabled`-not-`disabled`
  // in-flight guard `SessionList.tsx`'s own per-repository create button uses, so keyboard focus
  // never leaves the button mid-action.
  function handleQuickAction(): void {
    if (quickActionPendingRef.current) return
    quickActionPendingRef.current = true
    setQuickActionPending(true)
    captureFocusFallback()
    const wasArchived = isArchived
    const action = wasArchived ? restore(session.id) : archive(session.id)
    void action.then((ok) => {
      quickActionPendingRef.current = false
      setQuickActionPending(false)
      // Post-build review fix (Phase7PostBuild/code-reviewer, Medium): only announces -- and the
      // store already reported the failure through its own `notify` toast when `ok` is false --
      // a screen-reader user must never hear "Archived X" next to a visible failure toast.
      if (ok) onAnnounce(wasArchived ? `Restored ${session.name}` : `Archived ${session.name}`)
    })
  }

  // Issue #620, UX consult item 2 decisions 3, 5, 8, 9: creates instantly in this row's own
  // repository and default branch (no dialog), announces immediately (deferred until the menu
  // actually closes, see `pendingCreateAnnouncementRef`, since the modal menu keeps `#root`
  // `aria-hidden` through its close animation), then on success switches this screen back to
  // chat (`openChat`, decision 5's "opens that session" requirement, matching `handleOpen`
  // above) and focuses the new Session's pane -- but only while this screen is still showing
  // AND the user has not moved on in the meantime (gate round 2 High: `openChat` used to run
  // unconditionally, unmounting this screen -- and its live region -- out from under a user who
  // had navigated elsewhere during the multi-second checkout). When either is no longer true,
  // the chat view is left alone and "Created session {name}" is announced through the app-level
  // `chatAreaAnnouncer` instead, which survives regardless of which screen is showing. On
  // failure the same `isStillHere` check gates whether focus returns to the origin; the toast
  // (gate-fixes a11y High x2: a plain `toast.error` auto-dismisses, and had no
  // keyboard-reachable close control) always shows regardless, including for a rejected IPC
  // call. Absent from `actions` entirely (never called) when `repository` could not be resolved
  // -- see the `newSession` argument to `buildSessionRowActions` below.
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
    // Gate round 3 (code-review High): if the menu is still closing (`createRequestedRef` still
    // true), this `finish` is stashed in `settledCreateRef` instead of running now -- focus and
    // `#root`'s `aria-hidden` are not trustworthy yet, so `handleMenuCloseAutoFocus` runs it once
    // the content has actually unmounted. Otherwise (the ordinary, slower case) the menu has
    // already closed and `finish` runs immediately, exactly as before.
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
        const finish = () => {
          const stay = useViewStore.getState().view === 'manage-sessions' && isStillHere()
          if (!stay) {
            useChatAreaAnnouncer.getState().announce(`Created session ${result.value.name}`)
            return
          }
          useViewStore.getState().openChat(repository.id)
          requestAnimationFrame(() => {
            const { paneSessionIds, focusedIndex } = useSplitStore.getState()
            const focusedSessionId = paneSessionIds[focusedIndex]
            // Gate round 4 (all four reviewers): do not ignore whether a pane was actually
            // found -- `openChat` has already switched the view away from this (now unmounted)
            // screen, so a missing pane must not be left silently unfocused; fall back to the
            // same "always-connected" nav target `handleOpen` above implicitly relies on via
            // `focusSessionPane`'s own internal fallback chain.
            if (!(focusedSessionId && focusSessionPane(focusedSessionId))) {
              useChatAreaAnnouncer.getState().announce(`Created session ${result.value.name}`)
              focusSessionsNav()
            }
          })
        }
        if (createRequestedRef.current) settledCreateRef.current = finish
        else finish()
      })
      .catch((err) => restoreAfterCreateFailure(err instanceof Error ? err.message : String(err)))
  }

  // The row's "..." menu and its right-click context menu share this one action list:
  // one set of options, reachable two ways, never two menus to keep in sync. The list itself
  // (labels/order/archived-or-not/stopped-or-not) is shared with SessionList.tsx via
  // sessionActions.ts (spec 008 T026); only the side effects below (focus-fallback capture,
  // this row's own rename/delete-dialog state) stay local, since they differ per screen.
  const actions = buildSessionRowActions(
    session,
    {
      onNewSession: handleNewSession,
      onRename: () => {
        renameRequestedRef.current = true
        startRenaming()
      },
      onOpenInSplit: () => handleOpen({ ctrlKey: true }),
      onCopyPath: () => void copyPath(),
      onReveal: () => void reveal(),
      onArchive: () => {
        captureFocusFallback()
        deferAnnouncementRef.current = true
        void archive(session.id).then((ok) => {
          if (!ok) return
          const message = `Archived ${session.name}`
          if (deferAnnouncementRef.current) pendingAnnouncementRef.current = message
          else onAnnounce(message)
        })
      },
      onRestore: () => {
        captureFocusFallback()
        deferAnnouncementRef.current = true
        void restore(session.id).then((ok) => {
          if (!ok) return
          const message = `Restored ${session.name}`
          if (deferAnnouncementRef.current) pendingAnnouncementRef.current = message
          else onAnnounce(message)
        })
      },
      onStopAgent: () => void stopAgent(session.id),
      onDelete: () => {
        captureFocusFallback()
        setDeleteOpen(true)
      }
    },
    // A11y-review fix (gate round 1, Low): a repository whose git read failed carries no
    // default branch -- leave the item out entirely (`null`), rather than reading "New session
    // from " and creating on "".
    repository && repository.defaultBranch ? { branch: repository.defaultBranch, disabled: creatingThisRepository } : null
  )

  // `isContextMenu`: the right-click/Shift+F10 context menu is invoked from the row's whole
  // surface (not a normally-focusable element), so its own close-autofocus prefers sending focus
  // to the open button instead of the "..." trigger the user never started from.
  function handleMenuCloseAutoFocus(event: Event, isContextMenu = false): void {
    // Post-build review fix (accessibility-auditor, Medium, WCAG 4.1.3): Radix keeps `#root`
    // `aria-hidden` until this modal menu's content actually unmounts after its close animation
    // -- `onCloseAutoFocus` is the first point that reliably runs after that. An
    // archive/restore announcement chosen from this menu (or the matching context menu) is held
    // in `pendingAnnouncementRef` until here instead of firing the moment the IPC call
    // resolves, which can land mid-animation and get silently swallowed by the still-hidden
    // `#root`. The quick-action button (not a menu) is unaffected: it never sets
    // `deferAnnouncementRef`, so it keeps announcing immediately.
    deferAnnouncementRef.current = false
    if (pendingAnnouncementRef.current) {
      onAnnounce(pendingAnnouncementRef.current)
      pendingAnnouncementRef.current = null
    }
    if (renameRequestedRef.current) {
      event.preventDefault()
      renameRequestedRef.current = false
    } else if (createRequestedRef.current) {
      // Issue #620 decision 8, amended (gate round 1, a11y Medium): `preventDefault` alone left
      // focus on `<body>` for the whole multi-second checkout with no defined target (WCAG
      // 2.4.3/2.4.7) -- focuses the menu's own origin instead (the open button for a right-click/
      // Shift+F10 open, the "..." trigger for the dropdown; `createOriginRef` is set when the
      // menu OPENS, not here -- gate round 2 code-review Medium -- so a fast create settling
      // before this close handler runs still reads the right one). Also flushes the
      // announcement held in `pendingCreateAnnouncementRef` (a11y High) through the app-level
      // `chatAreaAnnouncer`, not `onAnnounce`, so it survives this screen unmounting.
      event.preventDefault()
      createRequestedRef.current = false
      if (pendingCreateAnnouncementRef.current) {
        useChatAreaAnnouncer.getState().announce(pendingCreateAnnouncementRef.current)
        pendingCreateAnnouncementRef.current = null
      }
      // Gate round 3 (code-review High): a create that settled WHILE this menu was still
      // closing stashed its own settle handler instead of running immediately (`handleNewSession`
      // above) -- run it now, the first point that reliably runs after the content has actually
      // unmounted and `#root`'s `aria-hidden` has lifted, so its own `isStillHere`/toast checks
      // see accurate state. Only when nothing was stashed (the create is still genuinely
      // running) does this fall back to parking focus on the menu's own origin while it waits
      // (gate round 2 Medium) -- never both, or a finished create's own focus move would be
      // immediately stolen back.
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

  return (
    <li ref={rowRef} className="relative w-full hover:bg-muted/50">
      {isVisible && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-active-indicator" />}
      {/* Post-build review fix (Phase7PostBuild, Medium): right-click/Shift+F10 opens the same
          options the "..." trigger does, matching SessionList.tsx's own row (DESIGN.md "Session
          list keyboard and focus model") -- the same object behaves identically on both screens. */}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) return
          // A11y-review fix (gate round 4, Low): reopening this menu while a previous create's
          // settle is still stashed means Radix's own close-autofocus for that earlier close may
          // never fire at all (superseded by this new open) -- run it now, before overwriting
          // `createOriginRef` for this new open, so the stashed `finish` still resolves the
          // origin it actually belongs to.
          const settled = settledCreateRef.current
          settledCreateRef.current = null
          createRequestedRef.current = false
          settled?.()
          createOriginRef.current = 'context'
          // A11y-review fix (gate round 2, LOW): Shift+F10/the Menu key opens this menu from
          // whatever element already has focus (for example the "..." trigger itself), not
          // always the row's open button -- prefer that element when it is genuinely inside
          // this row.
          const active = document.activeElement
          contextMenuOpenerRef.current = active instanceof HTMLElement && rowRef.current?.contains(active) ? active : null
        }}
      >
        <ContextMenuTrigger asChild>
          <div className="flex min-w-0 items-center gap-2 pr-2">
            {renaming ? (
              <input
                ref={renameInputRef}
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={handleNameKeyDown}
                aria-label="Session name"
                className="w-full min-w-0 flex-1 rounded border border-ring bg-transparent px-2 py-1.5 text-sm outline-none"
              />
            ) : (
              <button
                ref={openButtonRef}
                type="button"
                onClick={(event) => handleOpen(event)}
                onKeyDown={handleOpenButtonKeyDown}
                data-choice-item
                // Post-build review fix (Phase7PostBuild, Medium): a fixed grid, not a natural-width
                // flex row, so status/name/repository/state/time form real columns across every
                // row instead of each shifting with its own content's length. Padding moved onto
                // this button (off the wrapping `<li>`) so the hover fill below is entirely
                // clickable, with no dead gutter.
                className="manage-session-open-button grid min-w-0 flex-1 grid-cols-[8rem_minmax(8rem,24rem)_minmax(0,10rem)_minmax(0,9rem)_minmax(5rem,1fr)] items-center gap-3 rounded-md py-2 pl-3 pr-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {/* Post-build review fix (Phase7PostBuild, HIGH, WCAG 2.5.3/4.1.2): no
                    `aria-label` here -- it previously replaced the button's whole content with
                    "Open session X in repo", hiding status, branch, Archived, Worktree missing,
                    and last activity from screen-reader users entirely. The accessible name now
                    comes from this visible content, in the same order it is read. */}
                <span className="flex min-w-0 items-center gap-1.5">
                  <StateIcon status={displayStatus(session)} />
                  <span className="truncate text-xs text-muted-foreground">{STATUS_LABEL[displayStatus(session)]}</span>
                </span>
                {isVisible && <span className="sr-only">Shown in chat</span>}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    <span className="sr-only">Open </span>
                    {session.name}
                  </span>
                  <span className="flex min-w-0 items-center gap-1 font-code text-xs text-muted-foreground">
                    <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                    <span className="truncate">{session.branch}</span>
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{repositoryName}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs">
                  {worktreeMissing && (
                    <span className="flex shrink-0 items-center gap-1 text-destructive">
                      <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
                      Worktree missing
                    </span>
                  )}
                  {isArchived && (
                    <Badge variant="secondary" className="shrink-0">
                      <ArchiveIcon aria-hidden className="size-3" />
                      Archived
                    </Badge>
                  )}
                </span>
                <span className="text-right text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
              </button>
            )}
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={isArchived ? `Restore session ${session.name}` : `Archive session ${session.name}`}
                    aria-disabled={quickActionPending || undefined}
                    onClick={handleQuickAction}
                    className="rounded p-1.5 text-muted-foreground aria-disabled:opacity-50 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {isArchived ? <ArchiveRestoreIcon aria-hidden className="size-4" /> : <ArchiveIcon aria-hidden className="size-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{isArchived ? 'Restore' : 'Archive'}</TooltipContent>
              </Tooltip>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (!open) return
                  const settled = settledCreateRef.current
                  settledCreateRef.current = null
                  createRequestedRef.current = false
                  settled?.()
                  createOriginRef.current = 'dropdown'
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        ref={menuTriggerRef}
                        type="button"
                        aria-label={`${session.name} actions`}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <EllipsisVerticalIcon aria-hidden className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">More actions</TooltipContent>
                </Tooltip>
                <DropdownMenuContent className="max-w-80" onCloseAutoFocus={handleMenuCloseAutoFocus}>
                  {actions.map((action, index) =>
                    action.kind === 'separator' ? (
                      <DropdownMenuSeparator key={`sep-${index}`} />
                    ) : (
                      <DropdownMenuItem
                        key={action.key}
                        variant={action.variant}
                        disabled={action.disabled}
                        onSelect={action.onSelect}
                      >
                        <span className="min-w-0 whitespace-normal break-words">{action.label}</span>
                      </DropdownMenuItem>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-w-80" onCloseAutoFocus={(event) => handleMenuCloseAutoFocus(event, true)}>
          {actions.map((action, index) =>
            action.kind === 'separator' ? (
              <ContextMenuSeparator key={`sep-${index}`} />
            ) : (
              <ContextMenuItem
                key={action.key}
                variant={action.variant}
                disabled={action.disabled}
                onSelect={action.onSelect}
              >
                <span className="min-w-0 whitespace-normal break-words">{action.label}</span>
              </ContextMenuItem>
            )
          )}
        </ContextMenuContent>
      </ContextMenu>
      <DeleteDialog
        session={session}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => onAnnounce(`Deleted ${session.name}`)}
        onCancelled={() => {
          if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
          else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
          else searchInputRef.current?.focus()
        }}
      />
    </li>
  )
}
