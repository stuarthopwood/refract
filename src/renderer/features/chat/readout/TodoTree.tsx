// Issue #700/#701 slice (a)'s `PinnedTodoPanel.tsx` and slice (b)'s Todo hover-focus card both
// render the SAME task tree (phases, tasks with a status glyph plus word, a blocked task's own
// second "Blocked: <blocker>" line, an abandoned task's strike-through) -- extracted here
// (2026-10-21, issue #700/#701 slice (b)) so neither ever drifts onto a second, slightly
// different rendering of one task row. The panel still owns its OWN scroll-follow/collapse/
// focus-restore machinery; this file only ever owns the pure "how does one phase/task look".
import type { LucideIcon } from 'lucide-react'
import { CheckCircle2Icon, CircleAlertIcon, CircleDotIcon, CircleIcon, CircleSlashIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TodoPhase, TodoTask, TodoTaskStatus } from '../../../../shared/todo'
import { derivePhaseTotals, isPhaseFinished } from './todoDerive'

// Decision item 5's own status-icon table: In progress/Blocked/Abandoned show a visible word
// (`srOnly: false`); Pending/Done show the SAME word to a screen reader only (`srOnly: true`),
// since their icon+position already reads clearly for a sighted user. No icon is named for
// `pending` in the decision record (only in progress/done/abandoned/blocked are); a plain empty
// `Circle`, muted, is the only one of the five states left needing a shape of its own.
// Gate round (Stuart 2026-10-21, grilled): a completed task is a named exception to "done is
// grey" -- both the icon and the task text read `text-severity-success`, the same token
// Stage/subagent `finished` already uses (`subagentStatus.tsx:29-35`, #941); the icon SHAPE
// (CheckCircle2Icon) stays the non-colour cue, "Done" stays sr-only. See
// `docs/design/foundations-icons.md`'s matching exception entry.
const TASK_STATUS_GLYPH: Record<TodoTaskStatus, { Icon: LucideIcon; className: string; word: string; srOnly: boolean; muteText: boolean }> = {
  pending: { Icon: CircleIcon, className: 'text-muted-foreground', word: 'Pending', srOnly: true, muteText: false },
  in_progress: { Icon: CircleDotIcon, className: 'text-state-working', word: 'In progress', srOnly: false, muteText: false },
  completed: { Icon: CheckCircle2Icon, className: 'text-severity-success', word: 'Done', srOnly: true, muteText: false },
  blocked: { Icon: CircleAlertIcon, className: 'text-severity-warning', word: 'Blocked', srOnly: false, muteText: false },
  abandoned: { Icon: CircleSlashIcon, className: 'text-muted-foreground', word: 'Abandoned', srOnly: false, muteText: true }
}

/** Gate round 1 fix (Main P4): an unrecognised or missing status (a future OMP status this
 * slice has never seen) must never crash the render -- falls back to the quiet `pending` glyph
 * rather than throwing on an `undefined` table lookup. `readout_todo.rs`'s own `parse_todo_phases`
 * already normalises an unknown wire value to `"pending"` before this ever runs; this is the
 * renderer's own independent backstop, not a duplicate of that validation. */
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
  /** Gate round 1 fix 7 (#700/#701 slice b): the pinned panel (slice a) folds a finished phase
   * to one line; the Todo hover-focus card instead keeps every phase fully expanded at all
   * times (a momentary glance has no persistent collapsed state to restore), so it passes
   * `false` here. Defaults `true`, preserving the pinned panel's own existing behaviour
   * unchanged. */
  foldFinished?: boolean
}) {
  // Decision item 5: "Finished phases fold to one line and the current phase stays open. A
  // single phase gets no header" -- `showHeader` is `false` for the single-phase case, so
  // `finished` folding never applies there either (nothing to fold a header line DOWN to). A
  // phase WITH the current `in_progress` task can never be "finished" (an in-progress task is
  // neither done nor abandoned), so it never folds, with no extra check needed here.
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
            // Gate round 2 fix (Main, security-reviewer concern): the key must never derive
            // solely from agent-controlled text (`task.content`) -- two tasks can legitimately
            // share wording (same name in two phases, or a repeated step), and `phaseIndex`
            // alone does not disambiguate within a phase either. `phaseIndex`+`taskIndex` is
            // stable and unique regardless of task content, immune to any content collision.
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
      <Icon aria-hidden className={cn('mt-1 size-4 shrink-0', className)} />
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
