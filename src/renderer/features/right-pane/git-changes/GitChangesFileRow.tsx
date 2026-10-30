import { useEffect, useRef, useState } from 'react'
import { CheckIcon, Code2Icon, EllipsisVerticalIcon, EyeIcon, Loader2Icon, MinusIcon, PlusIcon } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useGitChangesStore } from '@/state'
import { DiffStatCounts } from '@/features/sessions/sessionDisplay'
import { STATUS_MARKS } from '../file-explorer/git-decoration'
import { focusGitRow, focusNearestGroupTrigger } from './focus'
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
  const isConflict = group === 'conflicts'
  const canStage = group !== 'staged'
  const fileName = entry.path.slice(entry.folder ? entry.folder.length + 1 : 0)

  // Mirrors `FileExplorerPanel.tsx`'s own `TreeNodeRow` transient "VS Code not found" state.
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

  const [confirmResolveOpen, setConfirmResolveOpen] = useState(false)
  const kebabTriggerRef = useRef<HTMLButtonElement>(null)
  const [actionPending, setActionPending] = useState(false)

  // Only restores focus if it's still sitting on `<body>` (nothing else claimed it) or already on
  // this SAME kebab trigger (a no-op either way).
  function restoreKebabFocusIfStillOwed(): void {
    const active = document.activeElement
    if (active === document.body || active === kebabTriggerRef.current) kebabTriggerRef.current?.focus()
  }

  async function handleStage(): Promise<void> {
    if (actionPending) return
    setActionPending(true)
    useChatAreaAnnouncer.getState().announce(`Staging ${fileName}…`)
    try {
      const result = await useGitChangesStore.getState().stage(sessionId, [entry.path])
      if (result.ok) {
        useChatAreaAnnouncer.getState().announce(`Staged ${fileName}`)
        if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
      } else {
        // A failed stage never moves the row to a new group, so the SAME kebab trigger is still
        // mounted right here.
        restoreKebabFocusIfStillOwed()
      }
    } finally {
      setActionPending(false)
    }
  }

  async function handleUnstage(): Promise<void> {
    if (actionPending) return
    setActionPending(true)
    useChatAreaAnnouncer.getState().announce(`Unstaging ${fileName}…`)
    try {
      const result = await useGitChangesStore.getState().unstage(sessionId, [entry.path])
      if (result.ok) {
        useChatAreaAnnouncer.getState().announce(`Unstaged ${fileName}`)
        if (!focusGitRow(sessionId, entry.path)) focusNearestGroupTrigger(sessionId, group)
      } else {
        restoreKebabFocusIfStillOwed()
      }
    } finally {
      setActionPending(false)
    }
  }

  async function handleConfirmResolve(): Promise<void> {
    setConfirmResolveOpen(false)
    await handleStage()
  }

  return (
    <div className="group/row flex w-full items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent/50" aria-busy={actionPending}>
      <button
        type="button"
        data-git-row-path={entry.path}
        onClick={onOpenDiff}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        {/* The kebab menu closes on select, so the row's status icon is the only place to show pending. */}
        {actionPending ? (
          <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <mark.Icon aria-hidden className={`size-4 shrink-0 ${mark.className}`} />
        )}
        <span className="sr-only">{`${mark.label} — Open diff for ${entry.path}`}</span>
        <span aria-hidden className="min-w-0 flex-1 truncate" title={entry.path}>
          {fileName}
          {entry.folder && <span className="ml-1 text-xs text-muted-foreground">{entry.folder}</span>}
        </span>
      </button>
      <DiffStatCounts added={entry.additions} removed={entry.deletions} compact accessibleLabel />
      {/* Not "(partial)": that would read as partially staged; this means the count hit the byte cap. */}
      {entry.partial && <span className="shrink-0 text-xs text-muted-foreground">(counts capped)</span>}
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={kebabTriggerRef}
            type="button"
            aria-label={`More actions for ${entry.path}`}
            aria-disabled={actionPending || undefined}
            onKeyDown={(event) => {
              if (actionPending && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) event.preventDefault()
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100 aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            <EllipsisVerticalIcon aria-hidden className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isConflict ? (
            <DropdownMenuItem icon={CheckIcon} onSelect={() => setConfirmResolveOpen(true)}>
              {`Mark ${fileName} as resolved`}
            </DropdownMenuItem>
          ) : canStage ? (
            <DropdownMenuItem icon={PlusIcon} onSelect={() => void handleStage()}>
              {`Stage ${fileName}`}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem icon={MinusIcon} onSelect={() => void handleUnstage()}>
              {`Unstage ${fileName}`}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem icon={EyeIcon} onSelect={onOpenDiff}>
            {`Open diff for ${fileName}`}
          </DropdownMenuItem>
          <DropdownMenuItem icon={Code2Icon} onSelect={() => void runOpenInVSCode()}>
            {`Open ${fileName} in VS Code`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isConflict && (
        <AlertDialog open={confirmResolveOpen} onOpenChange={setConfirmResolveOpen}>
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              kebabTriggerRef.current?.focus()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Mark {fileName} as resolved?</AlertDialogTitle>
              <AlertDialogDescription>
                This stages {entry.path} exactly as it is in the worktree right now. If any conflict markers
                (<code>{'<<<<<<<'}</code>, <code>{'======='}</code>, <code>{'>>>>>>>'}</code>) are still in the file, they are staged too.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  void handleConfirmResolve()
                }}
              >
                Mark as resolved
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
