import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentType, KeyboardEvent, Ref } from 'react'
import { ArchiveIcon, ChevronRightIcon, EllipsisVerticalIcon, FolderGit2Icon, FolderGitIcon, FolderPlusIcon, GitBranchPlusIcon, GitPullRequestIcon, LoaderCircleIcon, PlusIcon, RotateCwIcon } from 'lucide-react'
import { toast } from 'sonner'
import refractHero from '@/assets/brand/refract-hero.svg'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AddRepositoryDialog } from '@/features/sessions/AddRepositoryDialog'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { RemoveRepositoryDialog } from '@/features/sessions/RemoveRepositoryDialog'
import { focusRepositoryGroupOrReadiness, focusSessionPane, focusSessionRow, focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, usePullRequestsStore, useRepositoriesStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { validateRepositoryName } from '../../../shared/repositoryName'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { SessionDetailsCard } from './SessionDetailsCard'
import { describeStartProgress, describeStartProgressLabel } from './startProgressDisplay'
import { STATUS_LABEL, StateIcon, formatRelativeTime } from './sessionDisplay'
import { buildSessionRowActions } from './sessionActions'
import type { SessionRowAction } from './sessionActions'
import { useWorktreeActions } from './useWorktreeActions'
import { canResumeSession, resumeSession, stillEligibleAfterResume } from '@/features/chat/resume'
import { describeStopReason } from '@/features/chat/ChatPane'

function SessionRow({
  session,
  repository,
  showRepository
}: {
  session: SessionSummary
  repository: Repository
  // Issue #527 (UX consult): true only for a row rendered inside the new cross-repository
  // Archived group, where the repository is no longer implied by the surrounding group alone --
  // shows the repository name as a secondary label and marks the row "Archived" in its
  // accessible name, instead of relying on the row's position (the issue's own accessibility
  // note: never rely on position alone to say a Session is archived).
  showRepository?: boolean
}) {
  // Spec 005 (tasks.md T012, T015, T020): shown in either pane (FR-018's own "either pane"
  // reading, extended to this row's own marker); which pane specifically only matters to the
  // click handler below, not this visual marker.
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
  // `DropdownMenu`/`ContextMenu` `onOpenChange` below), not at close time -- a fast create that
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

  return (
    <li ref={rowRef} className="group relative w-full rounded-md">
      {isVisible && (
        <span aria-hidden className="absolute inset-y-0.5 left-0 z-10 w-0.5 rounded-full bg-active-indicator" />
      )}
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
          // Gate round 2 fix (Low): mirrors the create cleanup above -- reopening this menu
          // while a previous restore's own settle is still stashed means Radix's close-
          // autofocus for that earlier close may never fire again; run it now, before this new
          // open can overwrite anything it reads.
          const settledRestore = settledRestoreRef.current
          settledRestoreRef.current = null
          restoreRequestedRef.current = false
          settledRestore?.()
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
          {/* The whole row is one card surface (DESIGN.md "Square choice items"): this div, not
              the open button alone, carries the hover/selected background, so the "..." trigger
              reads as part of the same card rather than sitting past its edge. Full width of its
              <li>, no leftover gutter. No `rounded-md` here: the selected session row is one of
              the square-choice-item surfaces, and this div (not `data-choice-item`'s button) is
              the one actually painting that background, so it must stay square-cornered too. */}
          <div
            className={cn(
              'flex w-full items-center gap-2',
              isVisible ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent'
            )}
          >
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
              <SessionDetailsCard session={session} repository={repository} worktreeMissing={worktreeMissing}>
                <button
                  ref={openButtonRef}
                  type="button"
                  aria-current={isVisible ? 'true' : undefined}
                  // Spec 005 (FR-001, FR-008, FR-009, data-model.md transition table): Ctrl+click
                  // always opens a split (or replaces the unfocused pane / focuses it, per
                  // `openInSplit`'s own rules). A plain click on the already-focused pane's own
                  onClick={(event) => {
                    if (event.ctrlKey) {
                      openInSplit(session.id)
                      return
                    }
                    replaceFocused(session.id)
                    if (isFocusedPane) void open(session.id)
                  }}
                  onDoubleClick={startRenaming}
                  onKeyDown={handleOpenButtonKeyDown}
                  data-choice-item
                  // Issue #621 (close chat pane): a stable query target for `focusSessionRow`
                  // (lib/focus.ts) so closing this Session's only open pane can return focus
                  // here first, before falling back further to the Sessions nav itself.
                  data-session-open={session.id}
                  className="session-open-button flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 pl-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {/* Gate-fixes a11y Low finding (cycle 5): the row kept showing the 'stopped'
                      icon and label while `session.startProgress` was set (the live-starting
                      kind-based text further down is `sr-only`/`aria-hidden` only, no icon or
                      visible label change), so the accessible name read "Stopped … Starting
                      agent" -- two contradicting status words for the same row. */}
                  {session.startProgress ? (
                    <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
                  ) : (
                    <StateIcon status={session.status} />
                  )}
                  {/* Gate-fixes a11y Low finding (cycle 6): `describeStartProgressLabel` covers
                      'memory-deferred' too (previously hand-coded as only 'queued' vs
                      'Starting agent', silently misreporting "Starting agent" while the visible
                      text below says "waiting for memory to free up"). */}
                  <span className="sr-only">
                    {session.startProgress ? describeStartProgressLabel(session.startProgress.kind) : STATUS_LABEL[session.status]}
                  </span>
                  {isSplitOpen && isVisible && (
                    <span className="sr-only">{isFocusedPane ? '(focused pane)' : '(shown, unfocused pane)'}</span>
                  )}
                  {/* Issue #527 accessibility note: the Archived group's own flat cross-
                      repository list must not rely on position alone to say a Session is
                      archived. */}
                  {session.archivedAt && <span className="sr-only">Archived</span>}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{session.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{session.branch}</span>
                    {showRepository && (
                      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
                        <span className="truncate" title={repository.name}>{repository.name}</span>
                      </span>
                    )}
                    {session.startProgress ? (
                      // Issue #512 requirement 1: the Session row's own "Starting agent... N s"
                      // (the chat pane's banner carries the Keep waiting/Cancel buttons; this row
                      // just needs the live text, shown instead of the stale "Terminated
                      // unexpectedly" note underneath while a fresh start is already under way).
                      // Gate-fixes a11y finding: this span sits inside the row's open `<button>`,
                      // so a ticking visible name would re-speak the whole row every second while
                      // it has focus. `aria-hidden` keeps the tick visible-only -- the row's own
                      // static accessible name (above) already covers the static status word, so
                      // (gate-fixes a11y Low finding, cycle 6) this no longer repeats it in a
                      // second `sr-only` span, which spoke the status twice for the same row.
                      <span className="truncate text-xs text-muted-foreground" aria-hidden>
                        {describeStartProgress(session.startProgress)}
                      </span>
                    ) : (
                      // Quality-gate fix (cycle 6, 2026-10-08, code-reviewer, Low): mirrors ChatPane's
                      // `showTerminatedTitle` -- `worktree-missing`/`start-failed` have their own
                      // dedicated reason text and actions, so this row must not also claim the
                      // session "Terminated unexpectedly" for those two reasons.
                      session.status === 'stopped' &&
                      session.terminatedUnexpectedly &&
                      session.stopReason !== 'worktree-missing' &&
                      session.stopReason !== 'start-failed' && (
                        <span className="truncate text-xs text-destructive">Terminated unexpectedly</span>
                      )
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
                  {session.unread && (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-state-needs-you" />
                  )}
                  {session.unread && <span className="sr-only">Unread</span>}
                </button>
              </SessionDetailsCard>
            )}
            {/* Quality-gate fix (a11y, cycle 2, 2026-10-08): moved out of the Button -- a
                `role="status"` element nested inside a `<button>` is presentational to ARIA (a
                button's children never form part of the accessibility tree on their own), so it
                was never exposed as a live region at all. Always mounted (never created
                together with its own text, which a screen reader generally fails to announce),
                a sibling of the button, not conditional on `canResume` so it survives past the
                moment the button itself unmounts on a successful resume. */}
            <span role="status" className="sr-only">
              {resuming ? `Resuming ${session.name}…` : ''}
            </span>
            {canResume && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    ref={resumeButtonRef}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Resume ${session.name}`}
                    aria-disabled={resuming || undefined}
                    className="aria-disabled:opacity-50"
                    onClick={() => void handleResume()}
                  >
                    {resuming ? (
                      <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCwIcon aria-hidden className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Resume {session.name}</TooltipContent>
              </Tooltip>
            )}
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) return
                const settled = settledCreateRef.current
                settledCreateRef.current = null
                createRequestedRef.current = false
                settled?.()
                // Gate round 2 fix (Low): mirrors the create cleanup above -- see the matching
                // ContextMenu comment.
                const settledRestore = settledRestoreRef.current
                settledRestoreRef.current = null
                restoreRequestedRef.current = false
                settledRestore?.()
                createOriginRef.current = 'dropdown'
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  ref={menuTriggerRef}
                  type="button"
                  aria-label={`${session.name} actions`}
                  className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground focus:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
                >
                  <EllipsisVerticalIcon aria-hidden className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
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
        </ContextMenuTrigger>
        {/* Right-click opens the same options the "..." trigger does (T117 new feature): one
            action list, never a second menu to maintain. */}
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
        onDeleted={focusListContainer}
        onCancelled={() => {
          if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
          else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
          else focusSessionsNav()
        }}
      />
    </li>
  )
}

// Issue #527 decision 1: the one trigger styling (chevron, size, case, padding) shared by a
// Repository header and the cross-repository Archived header below, so the two headers cannot
// drift apart from each other again. A Repository header passes its own rename support; the
// Archived header (no rename, no actions) passes only a label.
// Issue #528: an optional leading `icon` slot (aria-hidden, decorative) plus `tooltip` text --
// when a Repository header's icon alone carries NEW information (remote vs local-only) not
// otherwise visible, `tooltip` both shows a Radix tooltip on hover/focus AND is appended to the
// trigger's own accessible name, so the status is never conveyed by the icon's shape alone to a
// screen reader that does not surface hover tooltips. The Archived header passes no tooltip:
// its icon is pure decoration, the visible "ARCHIVED (N)" label already says everything.
function GroupHeaderTrigger({
  label,
  title,
  icon: Icon,
  tooltip,
  triggerRef,
  onDoubleClick,
  onKeyDown
}: {
  label: string
  title?: string
  icon?: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  tooltip?: string
  triggerRef?: Ref<HTMLButtonElement>
  onDoubleClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const pathId = useId()
  // Gate round 2 fix (Low, a11y-auditor): dropping the native `title` below (so it never shows
  // a second overlapping tooltip) also dropped the repository's path from assistive tech
  // entirely, since that span was never focusable or read either way -- an `sr-only` span plus
  // `aria-describedby` restores it, only when there is a path to describe.
  const describedByPath = tooltip && title
  const trigger = (
    <CollapsibleTrigger
      ref={triggerRef}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      aria-label={tooltip ? `${label}, ${tooltip}` : undefined}
      // Gate round 1 fix (Low, a11y-auditor): without this, the Tooltip wrapper below adds its
      // own `aria-describedby` pointing at the SAME text `aria-label` above already carries, so
      // a screen reader would read the remote status twice for one hover/focus. Radix's Slot
      // merge lets this explicit prop win over the one Tooltip injects.
      aria-describedby={describedByPath ? pathId : undefined}
      className="group/trigger flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-sidebar-foreground/70 uppercase tracking-wide hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {/* Gate round 1 fix (High, code-reviewer): keying this off `data-state` broke the moment
          the whole trigger became a Tooltip's child too -- Radix's `TooltipTrigger` spreads its
          OWN `data-state` ('closed'/'delayed-open'/'instant-open') onto this element AFTER
          `CollapsibleTrigger` sets its own ('open'/'closed'), so `[data-state=open]` never
          matched on any repository header (the arrow stayed closed-looking even when the group
          was open). `aria-expanded` is set only by Collapsible and untouched by Tooltip, so
          keying off it instead is immune to this. */}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90" />
      {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
      <span className="truncate" title={tooltip ? undefined : title}>{label}</span>
      {describedByPath && (
        <span id={pathId} className="sr-only">
          {title}
        </span>
      )}
    </CollapsibleTrigger>
  )
  if (!tooltip) return trigger
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      {/* Gate round 1 fix (Medium, all four reviewers): the label span's own native `title` (the
          repository's absolute path) is dropped above whenever this Tooltip wraps the trigger,
          so the two tooltips never show at once -- the path moves in here instead, as a second
          line. `side="right"`: a full-width header's tooltip would otherwise open above it (the
          default `side="top"`) and cover the previous group's last row and its hover actions.
          Gate round 2 fix (Medium, a11y-auditor): `sideOffset={104}` pushes it clear of the
          always-present "+"/branch-picker/"..." buttons immediately to the trigger's right --
          without it, the tooltip opened right on top of them, and Radix keeps hoverable content
          open while the pointer is over it, blocking a click on any of the three. */}
      <TooltipContent side="right" align="start" sideOffset={104}>
        {/* Gate round 2 fix (Medium, code-reviewer): `TooltipContent` is `inline-flex`, so a
            bare `<br/>` between two text nodes does not start a new line -- wrapping both lines
            in their own `flex-col` container does, and `break-all` keeps a long Windows path
            from overflowing the tooltip's own width. */}
        <div className="flex flex-col gap-0.5">
          <span>{tooltip}</span>
          {title && <span className="break-all">{title}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function RepositoryGroup({
  repository,
  sessions
}: {
  repository: Repository
  sessions: SessionSummary[]
}) {
  const createSession = useSessionsStore((state) => state.create)
  // Issue #620, UX consult item 2 decision 6: this per-repository in-flight guard used to be a
  // private ref/state pair only this button could see -- it now lives in `sessions-store.ts`,
  // shared with the row's own "New session from {branch}" menu item and `NewSessionDialog`, so
  // `create()` itself enforces the guard and every caller's disabled state agrees. Subscribes to
  // a derived boolean (code-review fix, gate round 1), not the whole Set, so a create for one
  // repository does not re-render every OTHER repository's group too.
  const creating = useSessionsStore((state) => state.creatingRepositoryIds.has(repository.id))
  const renameRepository = useRepositoriesStore((state) => state.rename)
  const [removeOpen, setRemoveOpen] = useState(false)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  // Issue #480: inline rename, the same F2 / Enter / Esc / blur-commit pattern as the Session
  // row's own rename (`SessionRow` above) -- the model the issue names to copy.
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(repository.name)
  // Quality-gate fix (a11y, Medium, 2026-10-08): a failed rename keeps the field open (never
  // `setRenaming(false)` before the IPC call resolves) and shows this inline, tied to the input
  // via `aria-describedby`, instead of only a toast that drops the user's typed draft.
  const [renameError, setRenameError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef(false)
  const renameRequestedRef = useRef(false)
  const renameErrorId = `repository-rename-error-${repository.id}`

  async function handleQuickCreate(): Promise<void> {
    // Gate-fixes a code/a11y Medium (round 1): on `main` this returned early, silently, on a
    // second click of this still-`aria-disabled`-but-clickable button. Removing that guard left
    // a second click (or the #102 double-click itself) reach `create()`, which now refuses it
    // and shows an error toast for what used to be an inert no-op.
    if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) return
    const result = await createSession(repository.id, repository.defaultBranch)
    if (!result.ok) notify(result.error)
  }

  function startRenaming(): void {
    setDraftName(repository.name)
    setRenameError(null)
    setRenaming(true)
  }

  // Quality-gate fix (a11y, Medium, 2026-10-08): stays open on failure -- `setRenaming(false)`
  // only runs on an unchanged name or a successful rename, never before the IPC call settles --
  // so a rejected name (too long, a control character) keeps the field mounted with the user's
  // own typed text still in it and the error shown next to it, instead of a toast and a lost
  // draft.
  async function commitRename(): Promise<void> {
    const name = draftName.trim()
    if (name === repository.name) {
      setRenameError(null)
      setRenaming(false)
      return
    }
    // Quality-gate fix (cycle 2, 2026-10-08): validates client-side first, with the exact same
    // shared, code-point-aware rule the server enforces -- shows an over-long or disallowed
    // name's error immediately, with no round trip, and is the ONLY length cap now that the
    // input's own `maxLength` (UTF-16-unit-counted, wrongly capped emoji at 30 instead of 60) is
    // gone.
    const clientError = validateRepositoryName(name)
    if (clientError) {
      // Quality-gate fix (cycle 3, 2026-10-08): the field stays mounted on an error (this
      // function's own doc comment above), so the restore-focus effect (keyed on `renaming`)
      // never fires here to clear this itself -- left set, a LATER successful blur-commit (the
      // user clicks elsewhere, `onBlur` re-commits with the same now-valid text) would still
      // yank focus back to the trigger, overriding wherever the user's click had just taken it.
      restoreFocusRef.current = false
      setRenameError(clientError)
      return
    }
    const error = await renameRepository(repository.id, name)
    if (error) {
      // Quality-gate fix (cycle 3, 2026-10-08): same reasoning as the client-validation branch
      // above -- a server-side rejection (for example a race with another rename) must not leave
      // this armed for a later unrelated success to consume.
      restoreFocusRef.current = false
      setRenameError(error)
      return
    }
    setRenameError(null)
    setRenaming(false)
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation()
    if (event.key === 'Enter') {
      restoreFocusRef.current = true
      void commitRename()
    }
    if (event.key === 'Escape') {
      restoreFocusRef.current = true
      setRenameError(null)
      setDraftName(repository.name)
      setRenaming(false)
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
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
    triggerRef.current?.focus()
  }, [renaming])

  // Issue #527: archived Sessions no longer get their own per-repository group here -- they all
  // move into one cross-repository `ArchivedGroup` at the bottom of the list instead.
  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  // Issue #528: a confirmed `none` is the only case that earns the plain "local only" icon --
  // `has` and the honest `unknown` "could not tell" case both get the same remote-capable icon,
  // so an unreadable repository or a parse failure is never shown as local-only when it might
  // not be (the issue's own accessibility rule: never a false claim either way).
  const remoteIcon = repository.remote?.kind === 'none' ? FolderGitIcon : FolderGit2Icon
  // Gate round 2 fix (Low, code-reviewer + security-auditor): `git config`'s raw configured URL
  // (unlike round 1's `git remote get-url`) never applies a `url.<base>.insteadOf` rewrite, so a
  // shorthand remote (for example `gh:owner/repo`) reports its literal, undotted alias as the
  // "host" -- still correctly classed `has` (the icon is right), but naming a fake host in the
  // tooltip would be worse than naming none. Only a host containing a dot is shown by name.
  const remoteTooltip =
    repository.remote?.kind === 'has'
      ? repository.remote.host.includes('.')
        ? `Git repository, remote: ${repository.remote.host}`
        : 'Git repository, has a remote'
      : repository.remote?.kind === 'none'
        ? 'Git repository, local only (no remote)'
        : 'Git repository'
  return (
    <div className="flex flex-col" data-repository-id={repository.id}>
      <Collapsible defaultOpen>
        <div className="group flex items-center gap-1 px-1">
          {renaming ? (
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <input
                ref={renameInputRef}
                autoFocus
                value={draftName}
                onChange={(event) => {
                  setDraftName(event.target.value)
                  setRenameError(null)
                }}
                onBlur={() => void commitRename()}
                onKeyDown={handleNameKeyDown}
                aria-label="Repository name"
                aria-invalid={renameError ? true : undefined}
                aria-describedby={renameError ? renameErrorId : undefined}
                className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-1 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {renameError && (
                <p id={renameErrorId} role="alert" className="px-1.5 text-xs text-destructive">
                  {renameError}
                </p>
              )}
            </div>
          ) : (
            <GroupHeaderTrigger
              triggerRef={triggerRef}
              label={repository.name}
              title={repository.path}
              icon={remoteIcon}
              tooltip={remoteTooltip}
              onDoubleClick={startRenaming}
              onKeyDown={handleTriggerKeyDown}
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`New session from ${repository.defaultBranch} in ${repository.name}`}
                aria-disabled={creating || undefined}
                className="aria-disabled:opacity-50"
                onClick={() => void handleQuickCreate()}
              >
                {creating ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <PlusIcon aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>New session from {repository.defaultBranch}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <NewSessionDialog
              repository={repository}
              trigger={
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`New session from a branch in ${repository.name}`}>
                    <GitBranchPlusIcon aria-hidden />
                  </Button>
                </TooltipTrigger>
              }
            />
            <TooltipContent>New session from a branch…</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                ref={menuTriggerRef}
                type="button"
                aria-label={`Repository actions for ${repository.name}`}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground focus:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
              >
                <EllipsisVerticalIcon aria-hidden className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              onCloseAutoFocus={(event) => {
                if (!renameRequestedRef.current) return
                renameRequestedRef.current = false
                event.preventDefault()
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  renameRequestedRef.current = true
                  startRenaming()
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}>
                Remove repository…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent>
          <ul aria-label={`${repository.name} sessions`} className="flex flex-col gap-0.5 py-1">
            {active.map((session) => (
              <SessionRow key={session.id} session={session} repository={repository} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
      <RemoveRepositoryDialog
        repository={repository}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onRemoved={focusRepositoryGroupOrReadiness}
        onCancelled={() => {
          if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
          else focusSessionsNav()
        }}
      />
    </div>
  )
}

// Issue #527 (UX consult decisions 1-4): one cross-repository Archived group at the very bottom
// of the list, a flat list (not sub-grouped by repository -- each row shows its own repository
// name instead), collapsed by default, hidden entirely while nothing anywhere is archived.
function ArchivedGroup({
  sessions,
  repositoriesById
}: {
  sessions: SessionSummary[]
  repositoriesById: Map<string, Repository>
}) {
  // Gate round 1 fix (code-reviewer, Low): counts and renders only rows whose repository is
  // actually still resolvable -- the invariant (no Session may outlive its own Repository) holds
  // in practice, but the header's own count must never silently disagree with what the list
  // below it actually shows if that invariant is ever violated transiently (for example mid-
  // store-update).
  const rows = sessions.filter((session) => repositoriesById.has(session.repositoryId))
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return (
    <div className="flex flex-col" data-archived-group="">
      <Collapsible>
        <div className="flex items-center gap-1 px-1">
          <GroupHeaderTrigger label={`Archived (${sorted.length})`} icon={ArchiveIcon} />
        </div>
        <CollapsibleContent>
          <ul aria-label="Archived sessions" className="flex flex-col gap-0.5 py-1">
            {sorted.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                // Non-null: `rows` above already filtered to sessions with a resolvable repository.
                repository={repositoriesById.get(session.repositoryId)!}
                showRepository
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// The session list (docs/DESIGN.md "Layout"): a collapsible group per Repository, Sessions
// sorted by most recent activity, and one cross-repository Archived group at the bottom of the
// list (issue #527). Its header (the Refract icon and name, spec 001 T100, FR-057) starts at the
// very top of the window and is part of the app's merged top row: draggable to move the window,
// double-click to maximise or restore.
export function SessionList() {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)
  const openPullRequests = useViewStore((state) => state.openPullRequests)
  const view = useViewStore((state) => state.view)
  const selectPullRequest = usePullRequestsStore((state) => state.selectPullRequest)
  // Issue #620, UX consult item 2 decision 9: the row menu's "New session from {branch}" item's
  // "Creating session from {branch}" / "Created session {name}" announcements now go through
  // the app-level `useChatAreaAnnouncer` (#621's shared announcer, now that it exists on
  // `origin/main`) instead of a local region here, so they survive the view swapping to
  // Settings or Manage sessions during the multi-second checkout (gate round 2, a11y High) --
  // no `onAnnounce` prop or local live region needed in this file any more.
  // specs/003-pull-request-management FR-001, T011: the left-nav entry has no row of its own to
  // scope a repository from, unlike a Session row -- defaults to the currently focused pane's
  // Session's repository (App.tsx's own `frontSessionId` derivation), falling back to the first
  // added repository. `PullRequestsView.tsx`'s own repository dropdown (T012) is where the
  // developer changes this afterward.
  function defaultRepositoryId(): string | undefined {
    const splitState = useSplitStore.getState()
    const focusedSessionId = splitState.paneSessionIds[splitState.focusedIndex] ?? splitState.paneSessionIds[0]
    const focusedSession = sessions.find((session) => session.id === focusedSessionId)
    return focusedSession?.repositoryId ?? repositories[0]?.id
  }

  function handleOpenPullRequests(): void {
    const repositoryId = defaultRepositoryId()
    if (!repositoryId) return
    selectPullRequest(repositoryId, null)
    openPullRequests(repositoryId)
  }

  return (
    <nav
      aria-label="Sessions"
      tabIndex={-1}
      className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {/* Part of the app's merged top row (spec 001 T100, FR-057): draggable to move the window.
          No double-click handler here: verified live (tasks.md T100) that double-clicking this
          `.drag-region` already maximises/restores the window entirely at the OS level (HTCAPTION)
          before the double-click ever reaches the page's own JS, so a renderer-driven toggle was
          dead code and has been removed. */}
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 px-3">
        <img src={refractHero} alt="" aria-hidden className="size-5 shrink-0" />
        <span className="text-sm font-semibold">Refract</span>
      </div>
      {/* specs/003-pull-request-management FR-001, T011: above the repository groups, Stuart's
          placement answer (spec 003 Clarifications). `aria-current` gives the selected state a
          visible AND accessible signal while the view is open, never colour alone (FR-030). */}
      <Button
        variant="ghost"
        aria-current={view === 'pull-requests' ? 'page' : undefined}
        className={cn(
          'mx-2 mt-2 h-8 justify-start gap-2 px-2 text-sm font-medium',
          view === 'pull-requests' && 'bg-sidebar-accent text-sidebar-accent-foreground'
        )}
        aria-label="Pull requests"
        onClick={handleOpenPullRequests}
      >
        <GitPullRequestIcon aria-hidden className="size-4" />
        Pull requests
      </Button>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-2">
          {repositories.map((repository) => (
            <RepositoryGroup
              key={repository.id}
              repository={repository}
              sessions={sessions.filter((session) => session.repositoryId === repository.id)}
            />
          ))}
          <ArchivedGroup
            sessions={sessions.filter((session) => session.archivedAt)}
            repositoriesById={new Map(repositories.map((repository) => [repository.id, repository]))}
          />
        </div>
      </ScrollArea>
      {/* #447: the only way to add another repository once the first-run screen is gone. A
          persistent footer so it is always reachable; the dialog keeps its own validation and
          returns focus here on close. */}
      <div className="shrink-0 border-t border-sidebar-border p-2">
        <AddRepositoryDialog
          trigger={
            <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-sm font-medium">
              <FolderPlusIcon aria-hidden className="size-4" />
              Add repository
            </Button>
          }
        />
      </div>
    </nav>
  )
}
