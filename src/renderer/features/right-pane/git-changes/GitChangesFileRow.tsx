// Spec 018 slice 1 (issue #464), User Story 1: one file row inside a `GitChangesGroup` --
// status icon+text (reusing `FileExplorerPanel.tsx`'s own `STATUS_MARKS` map unchanged,
// research.md decision 2), name + containing folder (FR-005), a `DiffStatCounts` badge, and the
// per-file actions (Stage/Unstage, Open diff, Open in VS Code, FR-006) behind a kebab menu --
// the same established per-row-actions idiom `FileExplorerPanel.tsx`'s own `TreeNodeRow` already
// uses, rather than a second one-off pattern. Clicking the row's own name/folder area is
// "selecting a row" (FR-008 acceptance scenario 5): it opens the diff exactly like the explicit
// "Open diff" menu item.
import { useEffect, useState } from 'react'
import { Code2Icon, EllipsisVerticalIcon, EyeIcon, MinusIcon, PlusIcon } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useGitChangesStore } from '@/state'
import { DiffStatCounts } from '@/features/sessions/sessionDisplay'
import { STATUS_MARKS } from '../file-explorer/FileExplorerPanel'
import type { GitChangesFileEntry, GitChangesGroupKind } from '../../../../shared/model'

export function GitChangesFileRow({
  entry,
  group,
  sessionId,
  onOpenDiff
}: {
  entry: GitChangesFileEntry
  group: GitChangesGroupKind
  sessionId: string
  onOpenDiff: () => void
}) {
  const mark = STATUS_MARKS[entry.mark]
  const canStage = group !== 'staged'
  const fileName = entry.path.slice(entry.folder ? entry.folder.length + 1 : 0)

  // Mirrors `FileExplorerPanel.tsx`'s own `TreeNodeRow` transient "VS Code not found" state
  // (FR-017, same shared action #463 already exposes) -- a normal result, not an IPC error, so
  // it shows inline rather than as a toast, and auto-clears rather than lingering forever.
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])

  async function runOpenInVSCode(): Promise<void> {
    const result = await window.refract.fileExplorer.openInVSCode(sessionId, entry.path)
    setVscodeNotFound(result.ok ? !result.value.opened : true)
  }

  return (
    <div className="group/row flex w-full items-center gap-1.5 rounded px-1 py-1 text-sm hover:bg-accent/50">
      <button
        type="button"
        onClick={onOpenDiff}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <mark.Icon aria-hidden className={`size-3.5 shrink-0 ${mark.className}`} />
        <span className="sr-only">{mark.label}</span>
        <span className="min-w-0 flex-1 truncate" title={entry.path}>
          {fileName}
          {entry.folder && <span className="ml-1.5 text-xs text-muted-foreground">{entry.folder}</span>}
        </span>
      </button>
      <DiffStatCounts added={entry.additions} removed={entry.deletions} compact accessibleLabel />
      {entry.partial && <span className="shrink-0 text-xs text-muted-foreground">(partial)</span>}
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${entry.path}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100"
          >
            <EllipsisVerticalIcon aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canStage ? (
            <DropdownMenuItem onSelect={() => void useGitChangesStore.getState().stage(sessionId, [entry.path])}>
              <PlusIcon aria-hidden className="size-3.5" />
              Stage
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void useGitChangesStore.getState().unstage(sessionId, [entry.path])}>
              <MinusIcon aria-hidden className="size-3.5" />
              Unstage
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onOpenDiff}>
            <EyeIcon aria-hidden className="size-3.5" />
            Open diff
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void runOpenInVSCode()}>
            <Code2Icon aria-hidden className="size-3.5" />
            Open in VS Code
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
