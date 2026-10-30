// One task tree shared by `PinnedTodoPanel.tsx` and the Todo hover-focus card; the panel owns scroll-follow/collapse/focus-restore (#700, #701).
import type { LucideIcon } from 'lucide-react'
import { CheckCircle2Icon, CircleAlertIcon, CircleDotIcon, CircleIcon, CircleSlashIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TodoPhase, TodoTask, TodoTaskStatus } from '../../../../shared/todo'
import { derivePhaseTotals, isPhaseFinished } from './todoDerive'

// In progress/Blocked/Abandoned show a visible word; Pending/Done show it to screen readers only.
// A completed task reads `text-severity-success` (same token as a finished Stage/subagent, #941); the
// icon shape stays the non-colour cue (`docs/design/foundations-icons.md`).
const TASK_STATUS_GLYPH: Record<TodoTaskStatus, { Icon: LucideIcon; className: string; word: string; srOnly: boolean; muteText: boolean }> = {
  pending: { Icon: CircleIcon, className: 'text-muted-foreground', word: 'Pending', srOnly: true, muteText: false },
  in_progress: { Icon: CircleDotIcon, className: 'text-state-working', word: 'In progress', srOnly: false, muteText: false },
  completed: { Icon: CheckCircle2Icon, className: 'text-severity-success', word: 'Done', srOnly: true, muteText: false },
  blocked: { Icon: CircleAlertIcon, className: 'text-severity-warning', word: 'Blocked', srOnly: false, muteText: false },
  abandoned: { Icon: CircleSlashIcon, className: 'text-muted-foreground', word: 'Abandoned', srOnly: false, muteText: true }
}

/** Falls back to the `pending` glyph for an unrecognised or missing status instead of throwing on an `undefined` lookup. */
export function statusGlyph(status: TodoTaskStatus) {
  return TASK_STATUS_GLYPH[status] ?? TASK_STATUS_GLYPH.pending
}

export function currentTaskKeyOf(phaseIndex: number, taskIndex: number): string {
  return `${phaseIndex}\u0000${taskIndex}`
}

export function TodoPhaseGroup({
  phase,
  phaseIndex,
  showHeader,
  currentTaskKey,
  foldFinished = true
}: {
  phase: TodoPhase
  phaseIndex: number
  showHeader: boolean
  currentTaskKey: string | null
  /** The pinned panel folds a finished phase to one line; the hover-focus card passes `false` to keep every phase expanded. Defaults `true`. */
  foldFinished?: boolean
}) {
  // Finished phases fold to one line and the current phase stays open; a single phase has no header, so never folds.
  const folded = foldFinished && showHeader && isPhaseFinished(phase)
  const phaseTotals = derivePhaseTotals(phase)
  return (
    <div className="py-1">
      {showHeader && (
        <div className="flex items-center gap-1 px-1 text-micro text-muted-foreground">
          {folded && <CheckCircle2Icon aria-hidden className="size-4 shrink-0" />}
          <span>
            {phase.name} {phaseTotals.done}/{phaseTotals.total}
          </span>
        </div>
      )}
      {!folded && (
        <ul className="space-y-1">
          {phase.tasks.map((task, taskIndex) => (
            // Key by index, not agent-controlled `task.content`, which can repeat across or within phases.
            <TodoTaskRow key={`${phaseIndex}-${taskIndex}`} task={task} isCurrent={currentTaskKeyOf(phaseIndex, taskIndex) === currentTaskKey} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function TodoTaskRow({ task, isCurrent }: { task: TodoTask; isCurrent: boolean }) {
  const { Icon, className, word, srOnly, muteText } = statusGlyph(task.status)
  return (
    <li data-current-task={isCurrent || undefined} className="flex items-start gap-2 px-1 py-1 text-xs">
      <Icon aria-hidden className={cn('size-4 shrink-0', className)} />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'block break-words',
            task.status === 'in_progress' && 'font-medium',
            task.status === 'abandoned' && 'text-muted-foreground line-through',
            task.status === 'completed' && 'text-severity-success',
            muteText && 'text-muted-foreground'
          )}
        >
          <span className={srOnly ? 'sr-only' : 'mr-1'}>{word}</span>
          {task.content}
        </span>
        {task.status === 'blocked' && task.blocker && <span className="block text-severity-warning">Blocked: {task.blocker}</span>}
      </div>
    </li>
  )
}
