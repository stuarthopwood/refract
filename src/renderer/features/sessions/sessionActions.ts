import type { SessionSummary } from '../../../shared/ipc'
import { canTogglePause } from '../chat/pauseActions'

/** A session row menu entry: a separator or an item. */
export type SessionRowAction =
  | { kind: 'separator' }
  | { kind: 'item'; key: string; label: string; variant?: 'destructive'; disabled?: boolean; onSelect: () => void }

/** Callbacks behind each session row menu item. */
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
  onTogglePause(): void
  onDelete(): void
  onNewSession?(): void
}

/** Builds the ordered action list for a session row. */
export function buildSessionRowActions(
  session: SessionSummary,
  handlers: SessionRowActionHandlers,
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
    { kind: 'item', key: 'open-in-split', label: 'Open in split', onSelect: handlers.onOpenInSplit },
    { kind: 'item', key: 'copy-path', label: 'Copy worktree path', onSelect: handlers.onCopyPath },
    { kind: 'item', key: 'reveal', label: 'Open worktree folder', onSelect: handlers.onReveal },
    session.hiddenAt
      ? { kind: 'item', key: 'unhide', label: 'Unhide', onSelect: handlers.onUnhide }
      : { kind: 'item', key: 'hide', label: 'Hide', onSelect: handlers.onHide },
    isArchived
      ? { kind: 'item', key: 'restore', label: 'Restore', onSelect: handlers.onRestore }
      : { kind: 'item', key: 'archive', label: 'Archive', onSelect: handlers.onArchive },
    ...(canTogglePause(session)
      ? ([
          { kind: 'separator' },
          {
            kind: 'item',
            key: 'pause',
            label: session.pause === 'pausing' ? 'Cancel pause' : session.pause ? 'Resume' : 'Pause',
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
