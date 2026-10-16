import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { notify, useSessionsStore, useSplitStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { buildSessionRowActions } from './sessionActions'
import type { SessionRowAction } from './sessionActions'
import { useWorktreeActions } from './useWorktreeActions'
import { canResumeSession, resumeSession, stillEligibleAfterResume } from '@/features/chat/resume'
import { describeStopReason } from '@/features/chat/ChatPane'
import { focusSessionPane, focusSessionRow, focusSessionsNav, isFocusStranded } from '@/lib/focus'

// Issue #811 (SessionList.tsx split): this is SessionRow's own body, moved unchanged -- archive,
// restore, delete, resume and rename state and handlers, plus the focus-after-removal fallback
// chain. SessionRow.tsx calls this hook and renders; every binding the JSX reads or calls is
// returned below, unchanged in name and behaviour.
export function useSessionRowActions(session: SessionSummary, repository: Repository) {
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
  const creatingThisRepository = useSessionsStore((state) => state.creatingRepositoryIds.has(repository.id))
  const rename = useSessionsStore((state) => state.rename)
  const archive = useSessionsStore((state) => state.archive)
  const restore = useSessionsStore((state) => state.restore)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [resuming, setResuming] = useState(false)
  const resumingRef = useRef(false)
  const resumeButtonRef = useRef<HTMLButtonElement>(null)
  // Issue #509 quality-gate fix: a successful resume flips `canResume` false on this row's
  // next render (its own button then disappears) -- without this, focus that was on the
  // button at click time would silently fall back to <body> (WCAG 2.1 AA focus-visibility).
  const resumeFocusPendingRef = useRef(false)
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
  const focusFallbackRef = useRef<() => void>(focusSessionsNav)

  // Captures the next still-connected place for focus to land after this row unmounts.
  function captureFocusFallback(): void {
    const li = rowRef.current
    const nextButton =
      (li?.nextElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.session-open-button') ?? null
    const prevButton =
      (li?.previousElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.session-open-button') ??
      null
    const groupRoot = li?.closest<HTMLElement>('[data-repository-id], [data-archived-group]') ?? null
    const trigger = groupRoot?.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]') ?? null
    focusFallbackRef.current = () => {
      if (nextButton?.isConnected) nextButton.focus()
      else if (prevButton?.isConnected) prevButton.focus()
      else if (trigger?.isConnected) trigger.focus()
      else focusSessionsNav()
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

  // Issue #509 (PLAN.md row A2g): icon-only, row-level Resume -- recovers the agent and sends the
  // default resume instruction as a real turn (`resumeSession`, shared with ChatPane's own Resume
  // button in the stop banner; `sessions.resume` itself holds the server-side single-flight
  // lock, so this ref only ever blocks this one button's own double click). aria-disabled, not
  // `disabled`, so keyboard focus stays on the button through the call (matches the
  // Quick-create button above).
  // Gate-fixes a11y Low finding (cycle 5): a Session mid-start after a Recover of an
  // `agent-exited` Session kept this true, showing an enabled Resume button next to this row's
  // own "Starting agent… N s" text -- ChatPane's banner already hides its own Resume for this
  // same state (`showBanner` requires `!startProgress`); this row disagreed.
  const canResume = !session.startProgress && canResumeSession(session.status, session.stopReason, session.terminatedUnexpectedly, !!session.archivedAt)

  // Quality-gate fix (cycle 2, 2026-10-08): only moves focus when it is actually stranded
  // (<body>, null, or disconnected) -- previously this ran unconditionally the instant
  // `canResume` flipped false, which could yank focus back to this row even if the user had
  // since tabbed away (or clicked elsewhere) during the call, matching `ChatPane.tsx`'s own
  // `maybeRestoreFocus` "stranded" test for its Recover/Retry buttons.
  useEffect(() => {
    if (canResume || !resumeFocusPendingRef.current) return
    resumeFocusPendingRef.current = false
    const active = document.activeElement
    const stranded = !active || active === document.body || !active.isConnected
    if (!stranded) return
    if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
    else focusListContainer()
  }, [canResume])

  async function handleResume(): Promise<void> {
    if (resumingRef.current) return
    resumingRef.current = true
    if (document.activeElement === resumeButtonRef.current) resumeFocusPendingRef.current = true
    setResuming(true)
    // Issue #603 quality-gate follow-up (Low, availability): wraps the call in try/finally --
    // an unhandled rejection from `resumeSession` (the preload bridge call itself, not an
    // `{ ok: false }` result) used to leave `resumingRef`/`setResuming` stuck true forever,
    // locking this row's Resume button for the rest of the session.
    try {
      const result = await resumeSession(session.id)
      // Quality-gate fix (cycle 5, 2026-10-08): `sessions.resume` can return `ok: true` with a
      // STILL-stopped snapshot when the restart itself failed (e.g. start-failed) --
      // `resumeSession.ts`'s own doc comment. Previously only `!result.ok` counted as a failure
      // here, so this case announced nothing: the row's "Resuming X…" status text just went
      // blank, `canResume` flipped false, the button disappeared, and focus returned to the open
      // button with no indication anything had gone wrong (WCAG 4.1.3, 3.3.1). The banner's own
      // `role="alert"` title change already announces this from the pane; the row had no
      // equivalent.
      const restartFailed = result.ok && result.value.runtime.status === 'stopped'
      if (!result.ok || restartFailed) {
        // Quality-gate fix (cycle 7, 2026-10-08, a11y-auditor, Medium): only clear the pending
        // flag when the Session is STILL resumable after this call -- a restart failure (ok:true,
        // still stopped, now e.g. stopReason:'start-failed') flips `canResume` to false exactly
        // like a genuine success does, so the effect above still needs to run and move focus onto
        // the open button once the Resume button disappears. Clearing it unconditionally here (as
        // cycle 5 did, back when a restart failure was not yet counted as this same kind of
        // failure) left focus stranded on `<body>` instead.
        const stillEligible = stillEligibleAfterResume(result, !!session.archivedAt)
        if (stillEligible) resumeFocusPendingRef.current = false
        notify(
          result.ok
            ? { code: 'invalid-argument', message: describeStopReason(result.value.runtime.stopReason, result.value.runtime.stopDetail) }
            : result.error
        )
      }
    } catch (err) {
      // Issue #603 quality-gate follow-up (Low, a11y): the try/finally above releases the lock
      // on an unhandled rejection (the bridge call itself throwing, not an `{ ok: false }`
      // result), but previously announced nothing. Round 2 (Low, a11y): clearing
      // `resumeFocusPendingRef` unconditionally here (as round 1 did) was wrong whenever the
      // rejection landed AFTER the restart actually succeeded server-side (the bridge call
      // itself threw on the way back, not the restart) -- `canResume` would then flip false
      // for this Session exactly like a normal success, and the effect above needs the flag
      // still armed to rescue focus once the button unmounts. Reads the freshest store state
      // (never the `session` prop this closure captured, now possibly stale) and only clears
      // when the Session is STILL resumable -- otherwise leaves it armed.
      const latest = useSessionsStore.getState().sessions.find((s) => s.id === session.id)
      if (latest && canResumeSession(latest.status, latest.stopReason, latest.terminatedUnexpectedly, !!latest.archivedAt)) {
        resumeFocusPendingRef.current = false
      }
      notify({ code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      resumingRef.current = false
      setResuming(false)
    }
  }

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

  // Issue #559 gate round 2 (the #900 pattern): a rename that makes this row's new name (or its
  // whole Project group, if this was its repo's only match) stop matching an active search
  // query unmounts it on a LATER render, once the sessions store refreshes from the IPC round
  // trip. If focus was on this row at that moment, it would otherwise land on `<body>`. A
  // `useLayoutEffect` cleanup is the last point that still sees focus genuinely inside the
  // about-to-be-removed `<li>` (`AskCard.tsx`'s own documented reason for the same choice, the
  // #900 precedent); deferred one rAF so the commit settles first, then `isFocusStranded`
  // (root `null`, checked globally) guards against stealing focus from wherever it validly
  // moved to. Empty deps: registered once per row instance, so the cleanup fires exactly once,
  // on this instance's real final unmount.
  useLayoutEffect(() => {
    return () => {
      if (!rowRef.current?.contains(document.activeElement)) return
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, null)) return
        document.querySelector<HTMLInputElement>('[data-session-search-input]')?.focus()
      })
    }
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
          requestAnimationFrame(() => {
            // Gate round 3 (code-review Medium): `focusSessionPane` can genuinely find no pane
            // (the view switched away, or the split closed) -- announce instead of silently
            // doing nothing in that case too, not only when the user has moved on. Gate round 4
            // (all four reviewers): when that happens while the user IS still here, deliberately
            // focus the origin too -- `isStillHere()` returning `true` can mean focus is
            // currently stranded on `<body>`, and leaving it there once more MUST NOT happen.
            const here = isStillHere()
            if (!(here && focusSessionPane(result.value.id))) {
              useChatAreaAnnouncer.getState().announce(`Created session ${result.value.name}`)
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
  const actions: SessionRowAction[] = buildSessionRowActions(
    session,
    {
      onNewSession: handleNewSession,
      onRename: () => {
        renameRequestedRef.current = true
        startRenaming()
      },
      onOpenInSplit: () => openInSplit(session.id),
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
      onArchive: () => {
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
      onRestore: () => {
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
      onStopAgent: () => void stopAgent(session.id),
      onDelete: () => {
        captureFocusFallback()
        setDeleteOpen(true)
      }
    },
    // A11y-review fix (gate round 1, Low): a repository whose git read failed carries no
    // default branch -- leave the item out entirely (`null`), the same as the Manage screen's
    // unresolved-repository case, rather than reading "New session from " and creating on "".
    repository.defaultBranch ? { branch: repository.defaultBranch, disabled: creatingThisRepository } : null
  )

  // `isContextMenu`: the right-click/Shift+F10 context menu is invoked from the row's open
  // button (the only normally-focusable element in the row), so its own close-autofocus prefers
  // sending focus straight back there instead of the "..." trigger the user never started from.
  function handleMenuCloseAutoFocus(event: Event, isContextMenu = false): void {
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
      } else if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) {
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
    actions, handleMenuCloseAutoFocus
  }
}
