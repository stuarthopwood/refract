import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Columns2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FootprintsIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  type LucideIcon
} from 'lucide-react'
import type { SessionSummary } from '../../../shared/ipc'
import { REVEAL_ACTION_LABEL, RevealActionIcon } from '@/components/revealAction'
import { canTogglePause } from '../chat/pauseActions'

/** A session row menu entry: a separator or an item. */
export type SessionRowAction =
  | { kind: 'separator' }
  | { kind: 'item'; key: string; label: string; icon: LucideIcon; variant?: 'destructive'; disabled?: boolean; onSelect: () => void }

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
  onStartAgent(): void
  onTogglePause(): void
  onDelete(): void
  onNewSession?(): void
  /** Present only where the menu can drive OMP; `state` is OMP's last report. */
  prewalk?: { state: 'armed' | 'off' | 'unknown'; onToggle(): void }
}

/** Builds the ordered action list for a session row; a Session being deleted in the background has none. */
export function buildSessionRowActions(
  session: SessionSummary,
  handlers: SessionRowActionHandlers,
  newSession: { branch: string; disabled: boolean } | null,
  deleting = false
): SessionRowAction[] {
  if (deleting) return []
  const isArchived = !!session.archivedAt
  return [
    ...(newSession
      ? ([
          {
            kind: 'item',
            key: 'new-session',
            icon: PlusIcon,
            label: `New session from ${newSession.branch}`,
            disabled: newSession.disabled,
            onSelect: () => handlers.onNewSession?.()
          },
          { kind: 'separator' }
        ] as const)
      : []),
    { kind: 'item', key: 'rename', icon: PencilIcon, label: 'Rename', onSelect: handlers.onRename },
    { kind: 'item', key: 'open-in-split', icon: Columns2Icon, label: 'Open in split', onSelect: handlers.onOpenInSplit },
    { kind: 'item', key: 'copy-path', icon: CopyIcon, label: 'Copy worktree path', onSelect: handlers.onCopyPath },
    { kind: 'item', key: 'reveal', icon: RevealActionIcon, label: REVEAL_ACTION_LABEL, onSelect: handlers.onReveal },
    session.hiddenAt
      ? { kind: 'item', key: 'unhide', icon: EyeIcon, label: 'Unhide', onSelect: handlers.onUnhide }
      : { kind: 'item', key: 'hide', icon: EyeOffIcon, label: 'Hide', onSelect: handlers.onHide },
    isArchived
      ? { kind: 'item', key: 'restore', icon: ArchiveRestoreIcon, label: 'Restore', onSelect: handlers.onRestore }
      : { kind: 'item', key: 'archive', icon: ArchiveIcon, label: 'Archive', onSelect: handlers.onArchive },
    ...(canTogglePause(session)
      ? ([
          { kind: 'separator' },
          {
            kind: 'item',
            key: 'pause',
            icon: session.pause ? PlayIcon : PauseIcon,
            label: session.pause === 'pausing' ? 'Cancel pause' : session.pause ? 'Resume' : 'Pause',
            onSelect: handlers.onTogglePause
          }
        ] as const)
      : []),
    ...(session.status === 'idle' && handlers.prewalk
      ? ([
          {
            kind: 'item',
            key: 'prewalk',
            icon: FootprintsIcon,
            label: handlers.prewalk.state === 'armed' ? 'Cancel prewalk (armed)' : 'Arm prewalk',
            onSelect: handlers.prewalk.onToggle
          }
        ] as const)
      : []),
    ...(session.status !== 'stopped'
      ? ([{ kind: 'item', key: 'stop', icon: SquareIcon, label: 'Stop agent', onSelect: handlers.onStopAgent }] as const)
      : isArchived
        ? []
        : ([{ kind: 'item', key: 'start', icon: PlayIcon, label: 'Start agent', onSelect: handlers.onStartAgent }] as const)),
    { kind: 'separator' },
    {
      kind: 'item',
      key: 'delete',
      icon: Trash2Icon,
      label: 'Delete…',
      variant: 'destructive',
      onSelect: handlers.onDelete
    }
  ]
}
