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

// Issue #811 (SessionList.tsx split): this is SessionRow's own body, moved unchanged -- archive,
// restore, delete, resume and rename state and handlers, plus the focus-after-removal fallback
// chain. SessionRow.tsx calls this hook and renders; every binding the JSX reads or calls is
// returned below, unchanged in name and behaviour.
export function useSessionRowActions(session: SessionSummary, repository: Repository | undefined, surface?: SessionRowSurface) {
  // Spec 005 (tasks.md T012, T015, T020): shown in either pane (FR-018's own "either pane"
  // reading, extended to this row's own marker); which pane specifically only matters to the
  // click handler in `SessionRow.tsx`, not this visual marker.
  const isVisible = useSplitStore((state) => state.paneSessionIds.includes(session.id))
  const isFocusedPane = useSplitStore((state) => {
    const index = state.paneSessionIds.indexOf(session.id)
    return index !== -1 && (state.paneSessionIds.length < 2 || state.focusedIndex === index)
  })
  // Quality-gate remediation (accessibility-auditor, Medium): while a split is open, TWO rows
  // can carry `aria-current="true"` at once (one per pane) -- nothing in the accessibility tree
  // said which of the two is the one a plain click/Enter actually targets. Only meaningful (and
  // only rendered) while a real split is open; a single pane's row is trivially "focused".
  const isSplitOpen = useSplitStore((state) => state.paneSessionIds.length === 2)
  const replaceFocused = useSplitStore((state) => state.replaceFocused)
  const openInSplit = useSplitStore((state) => state.openInSplit)
  // Quality-gate remediation (round 3): the "return to chat" behavior these three
  // session-targeting actions (plain click, Ctrl+click, and the 'Open in split' menu item
  // below) need now lives centrally in split-store.ts's `targetSession` -- the one function
  // both `openInSplit` and `replaceFocused` funnel through -- so it applies to every caller of
  // either, not just the ones wired up here by hand.
  const open = useSessionsStore((state) => state.open)
  const createSession = useSessionsStore((state) => state.create)
  // Code-review fix (gate round 1): subscribes to a derived boolean, not the whole Set, so a
  // create for one repository does not re-render every row in every OTHER repository too.
  const creatingThisRepository = useSessionsStore((state) => (repository ? state.creatingRepositoryIds.has(repository.id) : false))
  const rename = useSessionsStore((state) => state.rename)
  const archive = useSessionsStore((state) => state.archive)
  const restore = useSessionsStore((state) => state.restore)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
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
  // Issue #620, UX consult item 2 decision 8: set synchronously in `onNewSession`'s `onSelect`
  // below so `handleMenuCloseAutoFocus` knows to `preventDefault` Radix's own return-to-trigger
  // -- the create's own then-handler decides where focus actually goes once it settles (unlike
  // rename/list-focus above, there is nothing to focus yet at menu-close time).
  const createRequestedRef = useRef(false)
  // Code-review fix (gate round 2): set synchronously when either menu OPENS (see the
  // `DropdownMenu`/`ContextMenu` `onOpenChange` in `SessionRow.tsx`), not at close time -- a fast create that
  // settles before the menu's own close animation finishes used to read this back as `null`.
  const createOriginRef = useRef<'dropdown' | 'context' | null>(null)
  // A11y-review fix (gate round 2, LOW): the element that actually had focus when a right-click/
  // Shift+F10 context menu opened, when that element is inside this row -- a closer match than
  // always falling back to the open button (for example, Shift+F10 pressed while the "..."
  // trigger itself has focus).
  const contextMenuOpenerRef = useRef<HTMLElement | null>(null)
  // A11y-review fix (gate round 2, WCAG 4.1.3): the modal menu keeps `#root` `aria-hidden` and
  // is still mid-close-animation at the moment `onSelect` fires, so a polite announcement made
  // right there is lost every time. Held here and flushed once the menu actually closes (or
  // cleared the moment the create settles, so a fast failure/success is never followed by a
  // stale "Creating…" announcement); routed through the app-level `chatAreaAnnouncer` (#621),
  // not the local `onAnnounce`/`announcement` region this file used to keep just for this one
  // message -- that region is gone, since this one survives a view swap to Settings or Manage
  // sessions mid-create, which would otherwise unmount it (gate round 2 High).
  const pendingCreateAnnouncementRef = useRef<string | null>(null)
  // Code-review fix (gate round 3, High): if `create()` settles DURING the menu's own close
  // animation (focus is still on the now-portalled menu item, `#root` is still `aria-hidden`),
  // `isStillHere()` always reads false and the toast/announcement can be added while hidden --
  // deferred here instead: `handleNewSession`'s own settle handler stashes itself when
  // `createRequestedRef` is still true, and `handleMenuCloseAutoFocus`'s `createRequestedRef`
  // branch runs it once the content has actually unmounted and `aria-hidden` has lifted.
  const settledCreateRef = useRef<(() => void) | null>(null)
  // Issue #527 decision 5 (gate round 2 fix, High): mirrors `settledCreateRef`'s own pattern --
  // a restore that settles DURING the menu's own close animation (`restoreRequestedRef` still
  // true) stashes its finish function here instead of running immediately, since focus/`#root`
  // `aria-hidden` are not trustworthy yet; `handleMenuCloseAutoFocus`'s own `restoreRequestedRef`
  // branch runs it once the content has actually unmounted.
  const settledRestoreRef = useRef<(() => void) | null>(null)
  // Archive/restore/delete unmount this row asynchronously (the store update that moves it
  // out of the active/archived bucket can land before `onCloseAutoFocus` fires), and sometimes
  // the whole surrounding group unmounts with it (restoring the last archived Session also
  // collapses the Archived <Collapsible>). A plain `closest('ul')` captured once can therefore
  // itself be gone by the time focus needs to move, landing on <body> (WCAG 2.1 AA
  // focus-visibility). Instead this captures, synchronously in each action's `onSelect` while
  // the row is still mounted, a chain of fallback *elements* (next row, previous row, this row's
  // own group's always-present trigger -- a Repository's or, since issue #527, the cross-
  // repository Archived group's) and resolves it lazily against `isConnected`, falling back to
  // the Sessions nav root, which always outlives every row.
  // Issue #527 decision 5 (gate round 1 fix, High): mirrors `createRequestedRef`'s own
  // pattern -- set synchronously in `onRestore`'s `onSelect` below so `handleMenuCloseAutoFocus`
  // knows to `preventDefault` Radix's own return-to-trigger and park focus on the generic
  // nearby fallback instead, while the restore is in flight. `restoreParkedRef` remembers
  // exactly where that parked, so the later `stillHere` check in `onRestore`'s own `.then` can
  // tell a deliberate user move apart from focus simply still sitting where this branch left it.
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
    if (event.key === 'F2') {
      event.preventDefault()
      startRenaming()
    }
  }

  // `autoFocus` alone races Radix's dropdown-close focus handling: Radix restores focus (to
  // the removed menu item's former place, landing on <body>) via its own post-paint cleanup,
  // which runs after this render commits and steals focus back before a same-tick `autoFocus`
  // or effect can win (WCAG 2.1 AA focus-visibility). Deferring to the next animation frame
  // runs after that cleanup, so this is the last one to move focus; `onCloseAutoFocus` below
  // still stops Radix's own return-to-trigger on top of this.
  useEffect(() => {
    if (!renaming) return
    const raf = requestAnimationFrame(() => renameInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [renaming])

  // Enter/Escape unmount the focused rename input and remount the row's open button in its
  // place; without this, focus falls to <body> (WCAG 2.1 AA focus-visibility). Blur-triggered
  // commits (focus already moved elsewhere) must not steal focus back, so this only fires when
  // `restoreFocusRef` was armed by the Enter/Escape handler.
  useEffect(() => {
    if (renaming) return
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    openButtonRef.current?.focus()
  }, [renaming])

  // Issue #559 gate rounds 2-3 (the #900 pattern, finding 1): shared with `RepositoryGroup.tsx`
  // so a Project rename gets the exact same focus-redirect-to-search-field fix as a Session
  // rename, not a second, row-only copy. `restoreRequestedRef` (gate round 5, Main's finding 4)
  // lets this skip its own generic redirect while a restore for THIS row is in flight, since
  // `onRestore` below already has its own, more specific focus fallback.
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

  // Issue #620, UX consult item 2 decisions 3, 8, 9: creates instantly in this row's own
  // repository and default branch (no dialog, no base-branch picker), announces immediately
  // (held until the menu actually closes, see `pendingCreateAnnouncementRef`), then -- on
  // success -- focuses the new Session's pane one frame later, but only if the user has not
  // moved on in the meantime (still on the menu's own origin, this row, or `<body>`). On
  // failure, the same check gates whether focus returns there; the toast (gate-fixes a11y High
  // x2: a plain `toast.error` auto-dismisses, and had no keyboard-reachable close control)
  // always shows regardless, including for a rejected IPC call.
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
        const finish = surface ? () => surface.created(result.value, { isStillHere, focusOrigin }) : () => {
          requestAnimationFrame(() => {
            // Gate round 3 (code-review Medium): `focusSessionPane` can genuinely find no pane
            // (the view switched away, or the split closed) -- announce instead of silently
            // doing nothing in that case too, not only when the user has moved on. Gate round 4
            // (all four reviewers): when that happens while the user IS still here, deliberately
            // focus the origin too -- `isStillHere()` returning `true` can mean focus is
            // currently stranded on `<body>`, and leaving it there once more MUST NOT happen.
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

  // The row's "..." menu and its right-click context menu share this one action list:
  // one set of options, reachable two ways, never two menus to keep in sync. The list itself
  // (labels/order/archived-or-not/stopped-or-not) is shared with ManageSessionRow.tsx via
  // sessionActions.ts (spec 008 T026); only the side effects below (focus-fallback capture,
  // this row's own rename/delete-dialog state) stay local, since they differ per screen.
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
      // Issue #603 quality-gate follow-up (Low then Medium, a11y): archive can now be refused (a
      // resume in progress -- issue #603 item 1), so focus must only move toward the list on
      // SUCCESS. `listFocusRequestedRef` is no longer set synchronously here: Radix's own
      // close-autofocus (`handleMenuCloseAutoFocus' below) falls through to its generic
      // trigger/open-button fallback instead, keeping focus near this row by default -- correct
      // for a refusal, since the row never goes anywhere.
      //
      // Round 2 (Medium): `archive()` awaits main's own `shutdown()`, which can take seconds
      // (it waits out any start already running) -- moving focus unconditionally on success
      // could yank it away from wherever the user had since moved it (for example into the chat
      // textarea). Captures this row's own `<li>` before the call and only moves focus
      // afterward when it is stranded (body/disconnected/none) or still somewhere inside THIS
      // row -- never when the user has deliberately focused something else meanwhile.
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
      // Issue #527 decision 5: once the restore actually lands, send focus to the restored
      // row's own open button under its repository (`focusSessionRow`, #621) instead of only
      // the generic nearby fallback `captureFocusFallback` captured -- but only while the user
      // has not moved on in the meantime (still on this row, or on whatever the menu's own
      // close-autofocus parked focus on while the call was in flight).
      onRestore: surface ? surfaceArchive.onRestore : () => {
        restoreRequestedRef.current = true
        // Verif round 3 fix (Low): clears a stale value from an earlier action on this same
        // row before this restore's own parking (if any) sets it fresh -- `isStillHere` below
        // reads it, so a leftover value from a PREVIOUS restore could otherwise read as "the
        // user never moved" for a restore that hasn't parked anything yet.
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
              // Gate round 3 fix (High, security-auditor + a11y-auditor): a refused restore
              // settling BEFORE the menu actually closes stashes this finish without ever
              // parking focus first (`restoreParkedRef` is still null or stale from an earlier
              // action), so round 2's exact-match check against it was never true and focus was
              // left on `<body>`. Reuses the same `isStillHere()` check `onRestore`'s own
              // success path already relies on (covers body/disconnected/origin/parked/inside-
              // row), never only an exact match against wherever parking happened to land.
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
                // Gate round 2 fix (Medium, a11y-auditor): the restored row's own Repository
                // group can be collapsed -- fall back to that group's own header trigger (a
                // sane, specific destination) before the generic nearby fallback, and announce
                // the outcome either way, since nothing visibly received focus here from the
                // user's own perspective.
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
            // Gate round 1 fix (code-reviewer/a11y-auditor, High): `restore()` resolving only
            // means main wrote the registry and fired `session:list-changed` -- the renderer's
            // own `sessions` store only reflects the change after ITS OWN separate `refresh()`
            // round trip (`init-stores.ts`'s `onSessionListChanged` listener). Waits for the
            // store itself to confirm this Session is no longer archived before moving focus.
            if (!useSessionsStore.getState().sessions.find((s) => s.id === session.id)?.archivedAt) {
              settleOrRun()
              return
            }
            const unsubscribe = useSessionsStore.subscribe((state) => {
              if (state.sessions.find((s) => s.id === session.id)?.archivedAt) return
              unsubscribe()
              settleOrRun()
            })
            // Safety net: stop waiting (no leaked subscription) if the store never reflects the
            // restore -- a missed event, or the Session was deleted or re-archived meanwhile.
            window.setTimeout(unsubscribe, 5000)
          })
          .catch((err) => notify({ code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) }))
      },
      onHide: hideSession.hide,
      onUnhide: hideSession.unhide,
      onStopAgent: () => void stopAgent(session.id),
      onTogglePause: () => void setSessionPaused(session.id, !session.pause),
      onDelete: () => {
        captureFocusFallback()
        setDeleteOpen(true)
      }
    },
    // A11y-review fix (gate round 1, Low): a repository whose git read failed carries no
    // default branch -- leave the item out entirely (`null`), the same as the Manage screen's
    // unresolved-repository case, rather than reading "New session from " and creating on "".
    repository?.defaultBranch ? { branch: repository.defaultBranch, disabled: creatingThisRepository } : null
  )

  // `isContextMenu`: the right-click/Shift+F10 context menu is invoked from the row's open
  // button (the only normally-focusable element in the row), so its own close-autofocus prefers
  // sending focus straight back there instead of the "..." trigger the user never started from.
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
      // Issue #620 decision 8, amended (gate round 1, a11y Medium): `preventDefault` alone left
      // focus on `<body>` for the whole multi-second checkout with no defined target (WCAG
      // 2.4.3/2.4.7) -- focuses the menu's own origin instead (the open button for a right-click/
      // Shift+F10 open, the "..." trigger for the dropdown; `createOriginRef` is set when the
      // menu OPENS, not here -- gate round 2 code-review Medium -- so a fast create settling
      // before this close handler runs still reads the right one). Also flushes the
      // announcement held in `pendingCreateAnnouncementRef` (a11y High): this is the first point
      // that reliably runs after Radix's `#root` `aria-hidden` lifts post-close-animation.
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
      // Shared by the "..." dropdown and the right-click context menu. The dropdown's own
      // trigger is a real, focusable button, so Radix's default close-autofocus would land here
      // anyway -- but the context menu's trigger is the whole row `<div>` (not focusable), which
      // Radix cannot hand focus back to, so without this it falls through to `<body>` (WCAG 2.1
      // AA focus-visibility). Explicitly redirecting to the row's own focusable elements covers
      // both menus the same way: the "..." button if still mounted (also true after Copy path /
      // Open folder / Stop agent, none of which unmount the row), else the open button, else the
      // list itself.
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
    isVisible, isFocusedPane, isSplitOpen, replaceFocused, openInSplit, open,
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
