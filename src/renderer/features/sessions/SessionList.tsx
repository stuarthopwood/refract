import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'
import {
  BellRingIcon,
  ChevronRightIcon,
  CircleIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  LoaderCircleIcon,
  PlusIcon,
  SquareIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { focusSessionsNav } from '@/lib/focus'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { notify, useRepositoriesStore, useSessionsStore } from '@/state'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { Repository, SessionStatus } from '../../../shared/model'

const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  stopped: 'Stopped'
}

// ISO timestamps sort and compare lexically, so no Date parsing is needed until formatting.
function formatRelativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

// A distinct icon per Session state, never colour alone (docs/DESIGN.md "Look and feel").
function StateIcon({ status }: { status: SessionStatus }) {
  const className = 'size-4 shrink-0'
  switch (status) {
    case 'working':
      return <LoaderCircleIcon aria-hidden className={cn(className, 'animate-spin text-state-working')} />
    case 'idle':
      return <CircleIcon aria-hidden className={cn(className, 'text-state-idle')} />
    case 'needs-you':
      return <BellRingIcon aria-hidden className={cn(className, 'text-state-needs-you')} />
    case 'stopped':
      return <SquareIcon aria-hidden className={cn(className, 'text-state-stopped')} />
  }
}

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
  // T069: fetched fresh each time the details card opens, never cached across opens.
  const [diffStatResult, setDiffStatResult] = useState<DiffStat | null | 'loading'>('loading')
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

  // T069: tries the renderer's own Clipboard API first; the sandboxed renderer denies every
  // permission request/check (`src/main/index.ts`), so that throws here and this falls back to
  // the allowlisted main-process channel instead.
  async function handleCopyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(session.worktreePath)
      toast.success('Path copied')
      return
    } catch {
      // fall through to the main-process clipboard channel
    }
    const result = await window.refract.clipboard.writeText(session.worktreePath)
    if (result.ok) toast.success('Path copied')
    else notify(result.error)
  }

  async function handleReveal(): Promise<void> {
    const result = await window.refract.sessions.revealWorktree(session.id)
    if (!result.ok) notify(result.error)
  }

  // T069: fetches a fresh diff stat and re-lists Sessions (so a since-deleted worktree's
  // `stopReason` is current, not a stale cached value) every time the card opens.
  function handleCardOpenChange(open: boolean): void {
    if (!open) return
    setDiffStatResult('loading')
    void window.refract.sessions.diffStat(session.id).then((result) => {
      setDiffStatResult(result.ok ? result.value : null)
    })
    void useSessionsStore.getState().refresh()
  }

  return (
    <li ref={rowRef} className="group relative flex w-full items-center gap-2 rounded-md">
      {isVisible && (
        <span aria-hidden className="absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />
      )}
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
        <HoverCard openDelay={500} onOpenChange={handleCardOpenChange}>
          <HoverCardTrigger asChild>
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
              className={cn(
                'session-open-button flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 pl-3 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                isVisible && 'bg-sidebar-accent text-sidebar-accent-foreground'
              )}
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
          </HoverCardTrigger>
          <HoverCardContent>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <StateIcon status={session.status} />
                <span className="font-medium">{STATUS_LABEL[session.status]}</span>
                <span className="text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{repository.name}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{session.branch}</span>
                <span className="shrink-0 text-muted-foreground">from {session.baseBranch}</span>
              </div>
              <p className="min-w-0 break-all text-xs text-muted-foreground">
                {worktreeMissing ? (
                  <>
                    {session.worktreePath} <span className="text-destructive">(missing)</span>
                  </>
                ) : (
                  session.worktreePath
                )}
              </p>
              {/* Provider/model/reasoning-effort readout belongs here once T062 stores
                  `lastModel`/`lastThinkingLevel` on SessionSummary -- neither field exists yet, so
                  this is omitted rather than invented (no live source to read it from). */}
              <p className="text-xs text-muted-foreground">
                {worktreeMissing
                  ? 'Not available'
                  : diffStatResult === 'loading'
                    ? 'Counting changes…'
                    : diffStatResult === null
                      ? 'Not available'
                      : `${diffStatResult.files} files changed +${diffStatResult.additions} -${diffStatResult.deletions}${diffStatResult.partial ? ' (partial)' : ''}`}
              </p>
              <div className="flex items-center gap-1.5 pt-1">
                <Button variant="outline" size="xs" onClick={() => void handleCopyPath()}>
                  <CopyIcon aria-hidden />
                  Copy path
                </Button>
                <Button variant="outline" size="xs" onClick={() => void handleReveal()}>
                  <FolderOpenIcon aria-hidden />
                  Open in file explorer
                </Button>
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={menuTriggerRef}
            type="button"
            aria-label={`${session.name} actions`}
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-sidebar-border hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 aria-expanded:opacity-100"
          >
            <EllipsisVerticalIcon aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={(event) => {
            if (renameRequestedRef.current) {
              event.preventDefault()
              renameRequestedRef.current = false
            } else if (listFocusRequestedRef.current) {
              event.preventDefault()
              listFocusRequestedRef.current = false
              focusListContainer()
            }
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
          {/* T069: the same two actions the details card offers, kept here too since Radix hover
              cards are not keyboard-reachable. */}
          <DropdownMenuItem onSelect={() => void handleCopyPath()}>Copy worktree path</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleReveal()}>Open worktree folder</DropdownMenuItem>
          {isArchived ? (
            <DropdownMenuItem
              onSelect={() => {
                listFocusRequestedRef.current = true
                captureFocusFallback()
                void restore(session.id)
              }}
            >
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => {
                listFocusRequestedRef.current = true
                captureFocusFallback()
                void archive(session.id)
              }}
            >
              Archive
            </DropdownMenuItem>
          )}
          {session.status !== 'stopped' && (
            <DropdownMenuItem onSelect={() => void stopAgent(session.id)}>Stop agent</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              captureFocusFallback()
              setDeleteOpen(true)
            }}
          >
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
          <CollapsibleTrigger className="group/trigger flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-sidebar-foreground/70 uppercase tracking-wide hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
            <span className="truncate">{repository.name}</span>
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
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
                  <Button variant="ghost" size="icon-xs" aria-label={`New session from a branch in ${repository.name}`}>
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
export function SessionList() {
  const repositories = useRepositoriesStore((state) => state.repositories)
  const sessions = useSessionsStore((state) => state.sessions)

  return (
    <nav
      aria-label="Sessions"
      tabIndex={-1}
      className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
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
