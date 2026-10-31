import { FlagIcon, PaletteIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import type { SessionRowAction } from './sessionActions'

interface RepositoryActionHandlers {
  onRename(): void
  onColour(): void
  onReport(): void
  onRemove(): void
}

/** The repo header's menu entries, shared by its right-click and "..." menus so they cannot drift. */
export function buildRepositoryActions(handlers: RepositoryActionHandlers, hasGithubRemote: boolean): SessionRowAction[] {
  return [
    { kind: 'item', key: 'rename', icon: PencilIcon, label: 'Rename', onSelect: handlers.onRename },
    { kind: 'item', key: 'colour', icon: PaletteIcon, label: 'Project colour…', onSelect: handlers.onColour },
    ...(hasGithubRemote
      ? ([{ kind: 'item', key: 'report', icon: FlagIcon, label: 'GitHub report…', onSelect: handlers.onReport }] as const)
      : []),
    { kind: 'separator' },
    { kind: 'item', key: 'remove', icon: Trash2Icon, label: 'Remove project…', variant: 'destructive', onSelect: handlers.onRemove }
  ]
}
