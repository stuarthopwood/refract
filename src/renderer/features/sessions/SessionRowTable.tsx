// The shared Session row's table layout (#934, ADR 0003): the same row, its actions and its menus,
// as one scanning line with the columns the Manage sessions screen adds (state, name and branch,
// Project, flags, last active) and an always-visible Archive/Restore quick action. The primary open
// button covers only the info area; the quick action and "..." menu are its siblings, never nested
// inside it (a button must never contain another button).
import { ArchiveIcon, ArchiveRestoreIcon, EllipsisVerticalIcon, FolderGit2Icon, GitBranchIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/IconButton'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DeleteDialog } from '@/features/sessions/DeleteDialog'
import { cn } from '@/lib/utils'
import type { SessionSummary } from '../../../shared/ipc'
import { HiddenMarker } from './HiddenMarker'
import { StateIcon, displayLabel, displayStatus, formatRelativeTime } from './sessionDisplay'
import { ContextActionItems, DropdownActionItems, SessionRenameInput, onContextMenuOpenChange, onDropdownOpenChange } from './SessionRowParts'
import type { SessionRowSurface } from './sessionRowSurface'
import type { useSessionRowActions } from './useSessionRowActions'

export function SessionRowTable({
  session,
  projectName,
  surface,
  row
}: {
  session: SessionSummary
  projectName: string
  surface: SessionRowSurface
  row: ReturnType<typeof useSessionRowActions>
}) {
  const isArchived = !!session.archivedAt
  const deleting = row.deleting
  return (
    <li
      ref={row.rowRef}
      className={cn(
        'relative w-full',
        deleting && 'opacity-60',
        row.isVisible ? 'bg-accent text-accent-foreground' : !deleting && 'hover:bg-row-hover-bg'
      )}
    >
      {row.isVisible && <ActiveIndicatorBar />}
      <ContextMenu onOpenChange={(open) => onContextMenuOpenChange(row, open)}>
        <ContextMenuTrigger asChild disabled={deleting}>
          <div className="flex min-w-0 items-center gap-2 pr-2">
            {row.renaming ? (
              <SessionRenameInput row={row} />
            ) : (
              <button
                ref={row.openButtonRef}
                type="button"
                aria-disabled={deleting || undefined}
                onClick={(event) => {
                  if (!deleting) surface.open(event)
                }}
                onKeyDown={row.handleOpenButtonKeyDown}
                data-choice-item
                // A fixed grid, not a natural-width flex row, so the columns line up across every row.
                // The padding sits on this button so the whole hover fill is clickable.
                className="manage-session-open-button grid min-w-0 flex-1 grid-cols-[8rem_minmax(8rem,24rem)_minmax(0,10rem)_minmax(0,9rem)_minmax(5rem,1fr)] items-center gap-2 rounded-md py-2 pl-4 pr-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {/* No aria-label (WCAG 2.5.3, 4.1.2): one would replace the visible content and hide
                    status, branch, Archived, Worktree missing and last activity from screen readers.
                    The accessible name comes from this content, in reading order. */}
                <span className="flex min-w-0 items-center gap-2">
                  {deleting ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" /> : <StateIcon status={displayStatus(session)} />}
                  <span className="truncate text-xs text-muted-foreground">{deleting ? 'Deleting…' : displayLabel(session)}</span>
                </span>
                {row.isVisible && <span className="sr-only">Shown in chat</span>}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {!deleting && <span className="sr-only">Open </span>}
                    {session.name}
                    {deleting && <span className="sr-only">, deleting</span>}
                  </span>
                  <span className="flex min-w-0 items-center gap-1 font-code text-xs text-muted-foreground">
                    <GitBranchIcon aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{session.branch}</span>
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <FolderGit2Icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{projectName}</span>
                </span>
                <span className="flex min-w-0 items-center gap-2 text-xs">
                  {row.worktreeMissing && (
                    <span className="flex shrink-0 items-center gap-1 text-destructive">
                      <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
                      Worktree missing
                    </span>
                  )}
                  {isArchived && (
                    <Badge variant="secondary" className="shrink-0">
                      <ArchiveIcon aria-hidden className="size-4" />
                      Archived
                    </Badge>
                  )}
                  {session.hiddenAt && <HiddenMarker />}
                </span>
                <span className="text-right text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
              </button>
            )}
            {!deleting && (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  size="icon-xs"
                  label={isArchived ? `Restore session ${session.name}` : `Archive session ${session.name}`}
                  side="bottom"
                  aria-disabled={row.quickActionPending || undefined}
                  onClick={row.runQuickAction}
                  className="text-muted-foreground aria-disabled:opacity-50"
                >
                  {isArchived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
                </IconButton>
                <DropdownMenu onOpenChange={(open) => onDropdownOpenChange(row, open)}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      ref={row.menuTriggerRef}
                      size="icon-xs"
                      label={`More actions for ${session.name}`}
                      side="bottom"
                      className="text-muted-foreground"
                    >
                      <EllipsisVerticalIcon aria-hidden />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="max-w-80" onCloseAutoFocus={row.handleMenuCloseAutoFocus}>
                    <DropdownActionItems actions={row.actions} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-w-80" onCloseAutoFocus={(event) => row.handleMenuCloseAutoFocus(event, true)}>
          <ContextActionItems actions={row.actions} />
        </ContextMenuContent>
      </ContextMenu>
      <DeleteDialog
        session={session}
        open={row.deleteOpen}
        onOpenChange={row.setDeleteOpen}
        onDeleted={() => surface.announce(`Deleting ${session.name}`)}
        onCancelled={() => {
          if (row.menuTriggerRef.current?.isConnected) row.menuTriggerRef.current.focus()
          else if (row.openButtonRef.current?.isConnected) row.openButtonRef.current.focus()
          else surface.fallbackFocus()
        }}
      />
    </li>
  )
}
