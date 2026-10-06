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
  | { kind: 'item'; key: string; label: string; variant?: 'destructive'; onSelect: () => void }

export interface SessionRowActionHandlers {
  onRename(): void
  onOpenInSplit(): void
  onCopyPath(): void
  onReveal(): void
  onArchive(): void
  onRestore(): void
  onStopAgent(): void
  onDelete(): void
}

export function buildSessionRowActions(session: SessionSummary, handlers: SessionRowActionHandlers): SessionRowAction[] {
  const isArchived = !!session.archivedAt
  return [
    { kind: 'item', key: 'rename', label: 'Rename', onSelect: handlers.onRename },
    // Spec 005: same effect as Ctrl+click on the row's open button.
    { kind: 'item', key: 'open-in-split', label: 'Open in split', onSelect: handlers.onOpenInSplit },
    // The same two actions the details card offers, kept here too since Radix hover
    // cards are not keyboard-reachable.
    { kind: 'item', key: 'copy-path', label: 'Copy worktree path', onSelect: handlers.onCopyPath },
    { kind: 'item', key: 'reveal', label: 'Open worktree folder', onSelect: handlers.onReveal },
    isArchived
      ? { kind: 'item', key: 'restore', label: 'Restore', onSelect: handlers.onRestore }
      : { kind: 'item', key: 'archive', label: 'Archive', onSelect: handlers.onArchive },
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
