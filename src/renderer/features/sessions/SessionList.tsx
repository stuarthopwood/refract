import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronRightIcon, EllipsisVerticalIcon, GitBranchPlusIcon, LoaderCircleIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import refractHero from '@/assets/brand/refract-hero.png'
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
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { SessionDetailsCard } from './SessionDetailsCard'
import { STATUS_LABEL, StateIcon, formatRelativeTime } from './sessionDisplay'
import { useWorktreeActions } from './useWorktreeActions'

// One action descriptor list builds both the row's "..." dropdown menu and its right-click
// context menu (DESIGN.md "Session list keyboard and focus model"): the same options,
// reachable either way, never two separately-maintained menus.
type SessionRowAction =
  | { kind: 'separator' }
  | { kind: 'item'; key: string; label: string; variant?: 'destructive'; onSelect: () => void }

function SessionRow({ session, repository }: { session: SessionSummary; repository: Repository }) {
  const isVisible = useSessionsStore((state) => state.visibleSessionId === session.id)
  const open = useSessionsStore((state) => state.open)
  const setVisibleSessionId = useSessionsStore((state) => state.setVisibleSessionId)
  const rename = useSessionsStore((state) => state.rename)
  const archive = useSessionsStore((state) => state.archive)
  const restore = useSessionsStore((state) => state.restore)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { copyPath, reveal } = useWorktreeActions(session)
  const isArchived = !!session.archivedAt
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
  // one set of options, reachable two ways, never two menus to keep in sync.
  const actions: SessionRowAction[] = [
    {
      kind: 'item',
      key: 'rename',
      label: 'Rename',
      onSelect: () => {
        renameRequestedRef.current = true
        startRenaming()
      }
    },
    // The same two actions the details card offers, kept here too since Radix hover
    // cards are not keyboard-reachable.
    { kind: 'item', key: 'copy-path', label: 'Copy worktree path', onSelect: () => void copyPath() },
    { kind: 'item', key: 'reveal', label: 'Open worktree folder', onSelect: () => void reveal() },
    isArchived
      ? {
          kind: 'item',
          key: 'restore',
          label: 'Restore',
          onSelect: () => {
            listFocusRequestedRef.current = true
            captureFocusFallback()
            void restore(session.id)
          }
        }
      : {
          kind: 'item',
          key: 'archive',
          label: 'Archive',
          onSelect: () => {
            listFocusRequestedRef.current = true
            captureFocusFallback()
            void archive(session.id)
          }
        },
    ...(session.status !== 'stopped'
      ? ([{ kind: 'item', key: 'stop', label: 'Stop agent', onSelect: () => void stopAgent(session.id) }] as const)
      : []),
    { kind: 'separator' },
    {
      kind: 'item',
      key: 'delete',
      label: 'Delete…',
      variant: 'destructive',
      onSelect: () => {
        captureFocusFallback()
        setDeleteOpen(true)
      }
    }
  ]

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
                  // A non-visible row only flips visibility: ChatPane's [visibleSessionId] effect is the single
                  // opener and applies the snapshot (transcript, queue, pending requests, stop banner). The
                  // visible row has no such effect to fire, so clicking it (waking an asleep Session) opens directly.
                  onClick={() => (isVisible ? void open(session.id) : setVisibleSessionId(session.id))}
                  onDoubleClick={startRenaming}
                  onKeyDown={handleOpenButtonKeyDown}
                  data-choice-item
                  className="session-open-button flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 pl-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <StateIcon status={session.status} />
                  <span className="sr-only">{STATUS_LABEL[session.status]}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{session.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{session.branch}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
                  {session.unread && (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-state-needs-you" />
                  )}
                  {session.unread && <span className="sr-only">Unread</span>}
                </button>
              </SessionDetailsCard>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  ref={menuTriggerRef}
                  type="button"
                  aria-label={`${session.name} actions`}
                  className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 aria-expanded:opacity-100"
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
  // Per-repository in-flight guard: the ref blocks a second click before React re-renders (a
  // double-click), the state drives aria-disabled and the spinner. aria-disabled, not disabled,
  // so keyboard focus stays on the button.
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)

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

  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const archived = sessions.filter((session) => session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return (
    <div className="flex flex-col" data-repository-id={repository.id}>
      <Collapsible defaultOpen>
        <div className="flex items-center gap-1 px-1">
          <CollapsibleTrigger className="group/trigger flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-sidebar-foreground/70 uppercase tracking-wide hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
            <span className="truncate">{repository.name}</span>
          </CollapsibleTrigger>
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
  const openSettings = useViewStore((state) => state.openSettings)

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
        <img src={refractHero} alt="" aria-hidden className="size-5 shrink-0 rounded-md" />
        <span className="text-sm font-semibold">Refract</span>
        {/* Spec 004 FR-011, research.md decision 7: a temporary, plainly-labelled entry point to
            Settings (not styled as a profile item) -- spec 008's profile-item cog supersedes
            this once it lands. */}
        <Button
          variant="ghost"
          size="sm"
          className="no-drag-region ml-auto h-7 gap-1.5 px-2 text-muted-foreground"
          aria-label="Settings"
          onClick={() => openSettings()}
        >
          <SettingsIcon aria-hidden className="size-3.5" />
          Settings
        </Button>
      </div>
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
    </nav>
  )
}
