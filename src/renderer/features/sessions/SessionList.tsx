import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronRightIcon, EllipsisVerticalIcon, FolderPlusIcon, GitBranchPlusIcon, GitPullRequestIcon, LoaderCircleIcon, PlusIcon, RotateCwIcon } from 'lucide-react'
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
import { focusRepositoryGroupOrReadiness, focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, usePullRequestsStore, useRepositoriesStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { validateRepositoryName } from '../../../shared/repositoryName'
import { SessionDetailsCard } from './SessionDetailsCard'
import { STATUS_LABEL, StateIcon, formatRelativeTime } from './sessionDisplay'
import { buildSessionRowActions } from './sessionActions'
import type { SessionRowAction } from './sessionActions'
import { useWorktreeActions } from './useWorktreeActions'
import { canResumeSession, resumeSession } from '@/features/chat/resume'
import { describeStopReason } from '@/features/chat/ChatPane'

function SessionRow({ session, repository }: { session: SessionSummary; repository: Repository }) {
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
  const listFocusRequestedRef = useRef(false)
  // Archive/restore/delete unmount this row asynchronously (the store update that moves it
  // out of the active/archived bucket can land before `onCloseAutoFocus` fires), and sometimes
  // the whole surrounding group unmounts with it (restoring the last archived Session also
  // collapses the Archived <Collapsible>). A plain `closest('ul')` captured once can therefore
  // itself be gone by the time focus needs to move, landing on <body> (WCAG 2.1 AA
  // focus-visibility). Instead this captures, synchronously in each action's `onSelect` while
  // the row is still mounted, a chain of fallback *elements* (next row, previous row, this
  // Repository's always-present active-group trigger) and resolves it lazily against
  // `isConnected`, falling back to the Sessions nav root, which always outlives every row.
  const focusFallbackRef = useRef<() => void>(focusSessionsNav)

  // Captures the next still-connected place for focus to land after this row unmounts.
  function captureFocusFallback(): void {
    const li = rowRef.current
    const nextButton =
      (li?.nextElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.session-open-button') ?? null
    const prevButton =
      (li?.previousElementSibling as HTMLElement | null)?.querySelector<HTMLButtonElement>('.session-open-button') ??
      null
    const groupRoot = li?.closest<HTMLElement>('[data-repository-id]') ?? null
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
  const canResume = canResumeSession(session.status, session.stopReason, session.terminatedUnexpectedly, !!session.archivedAt)

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
    const result = await resumeSession(session.id)
    resumingRef.current = false
    setResuming(false)
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
      // Quality-gate fix (cycle 2, 2026-10-08): a failed resume usually leaves `canResume` still
      // true (the Session is still eligible), so the effect above would never fire and clear
      // this itself -- left set, a LATER unrelated `canResume` transition (a resume from the
      // OTHER entry point, or the Session later settling for any other reason) would wrongly
      // yank focus back to this row even though this call's own failure never earned that.
      resumeFocusPendingRef.current = false
      notify(
        result.ok
          ? { code: 'invalid-argument', message: describeStopReason(result.value.runtime.stopReason, result.value.runtime.stopDetail) }
          : result.error
      )
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

  // The row's "..." menu and its right-click context menu share this one action list:
  // one set of options, reachable two ways, never two menus to keep in sync. The list itself
  // (labels/order/archived-or-not/stopped-or-not) is shared with ManageSessionRow.tsx via
  // sessionActions.ts (spec 008 T026); only the side effects below (focus-fallback capture,
  // this row's own rename/delete-dialog state) stay local, since they differ per screen.
  const actions: SessionRowAction[] = buildSessionRowActions(session, {
    onRename: () => {
      renameRequestedRef.current = true
      startRenaming()
    },
    onOpenInSplit: () => openInSplit(session.id),
    onCopyPath: () => void copyPath(),
    onReveal: () => void reveal(),
    onArchive: () => {
      listFocusRequestedRef.current = true
      captureFocusFallback()
      void archive(session.id)
    },
    onRestore: () => {
      listFocusRequestedRef.current = true
      captureFocusFallback()
      void restore(session.id)
    },
    onStopAgent: () => void stopAgent(session.id),
    onDelete: () => {
      captureFocusFallback()
      setDeleteOpen(true)
    }
  })

  // `isContextMenu`: the right-click/Shift+F10 context menu is invoked from the row's open
  // button (the only normally-focusable element in the row), so its own close-autofocus prefers
  // sending focus straight back there instead of the "..." trigger the user never started from.
  function handleMenuCloseAutoFocus(event: Event, isContextMenu = false): void {
    if (renameRequestedRef.current) {
      event.preventDefault()
      renameRequestedRef.current = false
    } else if (listFocusRequestedRef.current) {
      event.preventDefault()
      listFocusRequestedRef.current = false
      focusListContainer()
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
      if (isContextMenu && openButtonRef.current?.isConnected) openButtonRef.current.focus()
      else if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
      else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
      else focusListContainer()
    }
  }

  return (
    <li ref={rowRef} className="group relative w-full rounded-md">
      {isVisible && (
        <span aria-hidden className="absolute inset-y-0.5 left-0 z-10 w-0.5 rounded-full bg-active-indicator" />
      )}
      <ContextMenu>
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
                  className="session-open-button flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 pl-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <StateIcon status={session.status} />
                  <span className="sr-only">{STATUS_LABEL[session.status]}</span>
                  {isSplitOpen && isVisible && (
                    <span className="sr-only">{isFocusedPane ? '(focused pane)' : '(shown, unfocused pane)'}</span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{session.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{session.branch}</span>
                    {/* Quality-gate fix (cycle 6, 2026-10-08, code-reviewer, Low): mirrors ChatPane's
                        `showTerminatedTitle` -- `worktree-missing`/`start-failed` have their own
                        dedicated reason text and actions, so this row must not also claim the
                        session "Terminated unexpectedly" for those two reasons. */}
                    {session.status === 'stopped' &&
                      session.terminatedUnexpectedly &&
                      session.stopReason !== 'worktree-missing' &&
                      session.stopReason !== 'start-failed' && (
                        <span className="truncate text-xs text-destructive">Terminated unexpectedly</span>
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
            <DropdownMenu>
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
              <DropdownMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
                {actions.map((action, index) =>
                  action.kind === 'separator' ? (
                    <DropdownMenuSeparator key={`sep-${index}`} />
                  ) : (
                    <DropdownMenuItem key={action.key} variant={action.variant} onSelect={action.onSelect}>
                      {action.label}
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        {/* Right-click opens the same options the "..." trigger does (T117 new feature): one
            action list, never a second menu to maintain. */}
        <ContextMenuContent onCloseAutoFocus={(event) => handleMenuCloseAutoFocus(event, true)}>
          {actions.map((action, index) =>
            action.kind === 'separator' ? (
              <ContextMenuSeparator key={`sep-${index}`} />
            ) : (
              <ContextMenuItem key={action.key} variant={action.variant} onSelect={action.onSelect}>
                {action.label}
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

function RepositoryGroup({ repository, sessions }: { repository: Repository; sessions: SessionSummary[] }) {
  const createSession = useSessionsStore((state) => state.create)
  const renameRepository = useRepositoriesStore((state) => state.rename)
  // Per-repository in-flight guard: the ref blocks a second click before React re-renders (a
  // double-click), the state drives aria-disabled and the spinner. aria-disabled, not disabled,
  // so keyboard focus stays on the button.
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)
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
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    try {
      const result = await createSession(repository.id, repository.defaultBranch)
      if (!result.ok) notify(result.error)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
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

  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const archived = sessions.filter((session) => session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
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
            <CollapsibleTrigger
              ref={triggerRef}
              onDoubleClick={startRenaming}
              onKeyDown={handleTriggerKeyDown}
              className="group/trigger flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-sidebar-foreground/70 uppercase tracking-wide hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
              <span className="truncate" title={repository.path}>{repository.name}</span>
            </CollapsibleTrigger>
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
      {archived.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group/trigger flex items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
            <span>Archived ({archived.length})</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul aria-label={`${repository.name} archived sessions`} className="flex flex-col gap-0.5 py-1">
              {archived.map((session) => (
                <SessionRow key={session.id} session={session} repository={repository} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
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

// The session list (docs/DESIGN.md "Layout"): a collapsible group per Repository, Sessions
// sorted by most recent activity, and a collapsed Archived group at the bottom of each group.
// Its header (the Refract icon and name, spec 001 T100, FR-057) starts at the very top of the
// window and is part of the app's merged top row: draggable to move the window, double-click to
// maximise or restore.
export function SessionList() {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)
  const openPullRequests = useViewStore((state) => state.openPullRequests)
  const view = useViewStore((state) => state.view)
  const selectPullRequest = usePullRequestsStore((state) => state.selectPullRequest)

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
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
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
