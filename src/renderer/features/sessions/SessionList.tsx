import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { BellRingIcon, ChevronRightIcon, CircleIcon, EllipsisVerticalIcon, LoaderCircleIcon, PlusIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { useRepositoriesStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
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

function SessionRow({ session }: { session: SessionSummary }) {
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
  const isArchived = !!session.archivedAt
  const rowRef = useRef<HTMLLIElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameRequestedRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const listFocusRequestedRef = useRef(false)

  // After a row unmounts (archive/restore/delete), focus must not fall back to <body>
  // (WCAG 2.1 AA focus-visibility): send it to the surrounding list.
  function focusListContainer(): void {
    rowRef.current?.closest('ul')?.focus()
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
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 pl-3 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
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
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
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
          {isArchived ? (
            <DropdownMenuItem
              onSelect={() => {
                listFocusRequestedRef.current = true
                void restore(session.id)
              }}
            >
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => {
                listFocusRequestedRef.current = true
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
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteDialog
        session={session}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={focusListContainer}
      />
    </li>
  )
}

function RepositoryGroup({ repository, sessions }: { repository: Repository; sessions: SessionSummary[] }) {
  const active = sessions.filter((session) => !session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const archived = sessions.filter((session) => session.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return (
    <div className="flex flex-col">
      <Collapsible defaultOpen>
        <div className="flex items-center gap-1 px-1">
          <CollapsibleTrigger className="group/trigger flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-sidebar-foreground/70 uppercase tracking-wide hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
            <span className="truncate">{repository.name}</span>
          </CollapsibleTrigger>
          <NewSessionDialog
            repository={repository}
            trigger={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New session in ${repository.name}`}
                title="New session"
              >
                <PlusIcon aria-hidden />
              </Button>
            }
          />
        </div>
        <CollapsibleContent>
          <ul tabIndex={-1} aria-label={`${repository.name} sessions`} className="flex flex-col gap-0.5 py-1 outline-none">
            {active.map((session) => (
              <SessionRow key={session.id} session={session} />
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
            <ul tabIndex={-1} aria-label={`${repository.name} archived sessions`} className="flex flex-col gap-0.5 py-1 outline-none">
              {archived.map((session) => (
                <SessionRow key={session.id} session={session} />
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
    <nav aria-label="Sessions" className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
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
