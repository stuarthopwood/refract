// One row in the Manage sessions screen (spec 008 FR-025, T026): a flat, cross-repository
// scanning row (visible status word, repository name, last activity), distinct from
// SessionList.tsx's own repository-grouped row -- but offering the IDENTICAL action set through
// the IDENTICAL shared list (sessionActions.ts), never a second hand-maintained menu. The
// primary "open" button covers only the info area; the quick action and "..." menu are its
// SIBLINGS, never nested inside it (a button must never contain another button).
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { buildSessionRowActions } from '@/features/sessions/sessionActions'
import { STATUS_LABEL, StateIcon, formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { useWorktreeActions } from '@/features/sessions/useWorktreeActions'
import { useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'

export interface ManageSessionRowProps {
  session: SessionSummary
  repositoryName: string
  /** Falls back here when this row unmounts (archive/restore/delete) and neither a next nor a
   *  previous row survives -- the search input is the one control on this screen guaranteed to
   *  outlive every row, the same "always-connected" role `focusSessionsNav` plays for
   *  SessionList.tsx (src/renderer/lib/focus.ts). */
  searchInputRef: RefObject<HTMLInputElement | null>
  onAnnounce(message: string): void
}

export function ManageSessionRow({ session, repositoryName, searchInputRef, onAnnounce }: ManageSessionRowProps) {
  const isVisible = useSplitStore((state) => state.paneSessionIds.includes(session.id))
  const isFocusedPane = useSplitStore((state) => {
    const index = state.paneSessionIds.indexOf(session.id)
    return index !== -1 && (state.paneSessionIds.length < 2 || state.focusedIndex === index)
  })
  const replaceFocused = useSplitStore((state) => state.replaceFocused)
  const openInSplit = useSplitStore((state) => state.openInSplit)
  const open = useSessionsStore((state) => state.open)
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
  const quickActionRef = useRef<HTMLButtonElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameRequestedRef = useRef(false)
  const restoreFocusRef = useRef(false)
  const listFocusRequestedRef = useRef(false)
  // Same fallback-CHAIN idea as SessionList.tsx's own `captureFocusFallback` (its own doc
  // comment explains why a plain `closest` captured once is not enough): next row, else
  // previous row, else the search input, resolved lazily against `isConnected` so it never
  // fires against an element this same unmount already took with it.
  const focusFallbackRef = useRef<() => void>(() => searchInputRef.current?.focus())

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
  // isFocusedPane wake-check), with one addition: this screen is not the chat view, so every
  // path also switches back to it (FR-025's own "opens that session" requirement).
  function handleOpen(event: { ctrlKey: boolean }): void {
    if (event.ctrlKey) {
      openInSplit(session.id)
    } else {
      replaceFocused(session.id)
      if (isFocusedPane) void open(session.id)
    }
    useViewStore.getState().openChat(session.repositoryId)
  }

  const actions = buildSessionRowActions(session, {
    onRename: () => {
      renameRequestedRef.current = true
      startRenaming()
    },
    onOpenInSplit: () => handleOpen({ ctrlKey: true }),
    onCopyPath: () => void copyPath(),
    onReveal: () => void reveal(),
    onArchive: () => {
      listFocusRequestedRef.current = true
      captureFocusFallback()
      void archive(session.id).then(() => onAnnounce(`Archived ${session.name}`))
    },
    onRestore: () => {
      listFocusRequestedRef.current = true
      captureFocusFallback()
      void restore(session.id).then(() => onAnnounce(`Restored ${session.name}`))
    },
    onStopAgent: () => void stopAgent(session.id),
    onDelete: () => {
      captureFocusFallback()
      setDeleteOpen(true)
    }
  })

  function handleMenuCloseAutoFocus(event: Event): void {
    if (renameRequestedRef.current) {
      event.preventDefault()
      renameRequestedRef.current = false
    } else if (listFocusRequestedRef.current) {
      event.preventDefault()
      listFocusRequestedRef.current = false
      focusListContainer()
    } else {
      event.preventDefault()
      if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
      else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
      else focusListContainer()
    }
  }

  function handleQuickAction(): void {
    listFocusRequestedRef.current = true
    captureFocusFallback()
    if (isArchived) void restore(session.id).then(() => onAnnounce(`Restored ${session.name}`))
    else void archive(session.id).then(() => onAnnounce(`Archived ${session.name}`))
  }

  return (
    <li ref={rowRef} className="relative w-full rounded-md border border-transparent hover:bg-muted/50">
      {isVisible && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-active-indicator" />}
      <div className="flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-2">
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
            aria-label={`Open session ${session.name} in ${repositoryName}`}
            onClick={(event) => handleOpen(event)}
            onDoubleClick={startRenaming}
            data-choice-item
            className="manage-session-open-button flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex shrink-0 items-center gap-1.5">
              <StateIcon status={session.status} />
              <span className="text-xs text-muted-foreground">{STATUS_LABEL[session.status]}</span>
            </span>
            {isVisible && <span className="sr-only">Open in chat</span>}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium" title={session.name}>
                {session.name}
              </span>
              <span className="flex items-center gap-1 truncate font-code text-xs text-muted-foreground">
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                {session.branch}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 truncate text-xs text-muted-foreground">
              <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
              {repositoryName}
            </span>
            {worktreeMissing && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
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
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
          </button>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <button
            ref={quickActionRef}
            type="button"
            aria-label={isArchived ? `Restore session ${session.name}` : `Archive session ${session.name}`}
            onClick={handleQuickAction}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {isArchived ? <ArchiveRestoreIcon aria-hidden className="size-4" /> : <ArchiveIcon aria-hidden className="size-4" />}
          </button>
          <DropdownMenu>
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
      </div>
      <DeleteDialog
        session={session}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => {
          onAnnounce(`Deleted ${session.name}`)
          focusListContainer()
        }}
        onCancelled={() => {
          if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus()
          else if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
          else searchInputRef.current?.focus()
        }}
      />
    </li>
  )
}
