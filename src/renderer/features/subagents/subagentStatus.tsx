import { cn } from '@/lib/utils'
import { STATUS_GLYPH, type StatusGlyphKey } from '../chat/statusGlyph'

export type SubagentRowStatus = 'running' | 'finished' | 'failed' | 'cancelled' | 'exited' | 'parked'

export const SUBAGENT_STATUS_LABEL: Record<SubagentRowStatus, string> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  exited: 'Agent exited',
  parked: 'Parked'
}

const GLYPH_KEY_BY_STATUS: Record<SubagentRowStatus, StatusGlyphKey> = {
  running: 'running',
  finished: 'success-done',
  failed: 'error',
  cancelled: 'cancelled',
  exited: 'neutral-muted',
  parked: 'parked'
}

export function isSubagentSuccessStatus(status: SubagentRowStatus): boolean {
  return GLYPH_KEY_BY_STATUS[status] === 'success-done'
}

export const SUBAGENT_SUCCESS_TEXT_CLASS = 'text-severity-success'

/** Shares the `--severity-error` token with the failed tool-call label. */
export const SUBAGENT_ERROR_TEXT_CLASS = 'text-severity-error'

// Takes `counts`, not a derived status, so both call sites share one "any member failed" rule.
export function subagentStatusTextClass(counts: Record<SubagentRowStatus, number>): string | undefined {
  if (counts.failed > 0) return SUBAGENT_ERROR_TEXT_CLASS
  if (counts.running === 0 && counts.cancelled === 0 && counts.exited === 0 && counts.parked === 0) return SUBAGENT_SUCCESS_TEXT_CLASS
  return undefined
}

function SubagentStatusGlyphIcons({ status }: { status: SubagentRowStatus }) {
  const { Icon, className } = STATUS_GLYPH[GLYPH_KEY_BY_STATUS[status]]
  return <Icon aria-hidden className={cn('size-4 shrink-0', className)} />
}

/** A distinct icon per state, never colour alone. */
export function SubagentStatusIcon({ status }: { status: SubagentRowStatus }) {
  return (
    <>
      <SubagentStatusGlyphIcons status={status} />
      <span className={cn('shrink-0 whitespace-nowrap', status === 'finished' && 'sr-only')}>{SUBAGENT_STATUS_LABEL[status]}</span>
    </>
  )
}

export function SubagentStatusGlyph({ status }: { status: SubagentRowStatus }) {
  return (
    <>
      <SubagentStatusGlyphIcons status={status} />
      <span className="sr-only">{SUBAGENT_STATUS_LABEL[status]}</span>
    </>
  )
}

export function chatRowStatus(status: 'running' | 'done' | 'error' | 'cancelled' | 'exited' | 'parked'): SubagentRowStatus {
  if (status === 'done') return 'finished'
  if (status === 'error') return 'failed'
  return status
}

export function summarizeSubagentStatuses(statuses: SubagentRowStatus[]): Record<SubagentRowStatus, number> {
  const counts: Record<SubagentRowStatus, number> = { running: 0, finished: 0, failed: 0, cancelled: 0, exited: 0, parked: 0 }
  for (const status of statuses) counts[status] += 1
  return counts
}
