// The one action list every session row offers (DESIGN.md "Session list keyboard and focus
// model"): rename, open in split, copy worktree path, open worktree folder, archive/restore,
// stop agent, delete. Extracted from SessionList.tsx's own `SessionRow` (spec 008 T026) so the
// Manage sessions screen's row (ManageSessionRow.tsx) can offer the IDENTICAL set through the
// IDENTICAL code, never a second hand-maintained copy that could drift from it. This module only
// builds the label/order/key list; each row still owns its own side effects (focus-fallback
// capture, local rename/delete-dialog state) via the handlers it passes in, since those differ
// between a repository-grouped row and a flat cross-repository one.
import type { SessionSummary } from '../../../shared/ipc'

export type SessionRowAction =
  | { kind: 'separator' }
  | { kind: 'item'; key: string; label: string; variant?: 'destructive'; disabled?: boolean; onSelect: () => void }

export interface SessionRowActionHandlers {
  onRename(): void
  onOpenInSplit(): void
  onCopyPath(): void
  onReveal(): void
  onArchive(): void
  onRestore(): void
  onHide(): void
  onUnhide(): void
  onStopAgent(): void
  // Issue #477: Pause when the Session is not paused, Resume when it is.
  onTogglePause(): void
  onDelete(): void
  // Issue #620: creates a Session from the row's own repository and its default branch. Absent
  // from the Manage sessions screen's row when its repository cannot be resolved (there is no
  // `newSession` item to select in that case -- see `newSession` below), so this is optional.
  onNewSession?(): void
}

export function buildSessionRowActions(
  session: SessionSummary,
  handlers: SessionRowActionHandlers,
  // Issue #620, UX consult item 2 decision 3/4: the row's own repository and its default branch,
  // created instantly, no dialog. `null` when the repository cannot be resolved (Manage sessions
  // screen's "Unknown repository" fallback, decision 5) -- the item is left out entirely rather
  // than shown disabled, since there is no repository to create into at all.
  newSession: { branch: string; disabled: boolean } | null
): SessionRowAction[] {
  const isArchived = !!session.archivedAt
  return [
    ...(newSession
      ? ([
          {
            kind: 'item',
            key: 'new-session',
            label: `New session from ${newSession.branch}`,
            disabled: newSession.disabled,
            onSelect: () => handlers.onNewSession?.()
          },
          { kind: 'separator' }
        ] as const)
      : []),
    { kind: 'item', key: 'rename', label: 'Rename', onSelect: handlers.onRename },
    // Spec 005: same effect as Ctrl+click on the row's open button.
    { kind: 'item', key: 'open-in-split', label: 'Open in split', onSelect: handlers.onOpenInSplit },
    // The same two actions the details card offers, kept here too since Radix hover
    // cards are not keyboard-reachable.
    { kind: 'item', key: 'copy-path', label: 'Copy worktree path', onSelect: handlers.onCopyPath },
    { kind: 'item', key: 'reveal', label: 'Open worktree folder', onSelect: handlers.onReveal },
    session.hiddenAt
      ? { kind: 'item', key: 'unhide', label: 'Unhide', onSelect: handlers.onUnhide }
      : { kind: 'item', key: 'hide', label: 'Hide', onSelect: handlers.onHide },
    isArchived
      ? { kind: 'item', key: 'restore', label: 'Restore', onSelect: handlers.onRestore }
      : { kind: 'item', key: 'archive', label: 'Archive', onSelect: handlers.onArchive },
    ...(session.status !== 'stopped' || session.pause
      ? ([
          {
            kind: 'item',
            key: 'pause',
            label: session.pause ? 'Resume' : 'Pause',
            onSelect: handlers.onTogglePause
          }
        ] as const)
      : []),
    ...(session.status !== 'stopped'
      ? ([{ kind: 'item', key: 'stop', label: 'Stop agent', onSelect: handlers.onStopAgent }] as const)
      : []),
    { kind: 'separator' },
    {
      kind: 'item',
      key: 'delete',
      label: 'Delete…',
      variant: 'destructive',
      onSelect: handlers.onDelete
    }
  ]
}
