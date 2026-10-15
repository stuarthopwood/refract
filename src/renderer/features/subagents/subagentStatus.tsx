// Shared subagent status vocabulary (issue #563 decision 14): one status-icon map reused by the
// chat transcript's SubagentRow, the new per-stage group row and subagent chain row, and the
// Subagent panel's tree -- so a running vs finished vs cancelled subagent never reads
// differently depending which of those surfaces shows it. Extends the icon set
// `SubagentPanel.tsx`'s own (pre-#563) `SubagentStateIcon` (running/finished/failed/exited) with
// `cancelled` (decision 15, split out of failed: a cancel/abort is not a failure).
import { CheckCircle2Icon, CircleStopIcon, LoaderCircleIcon, UnplugIcon, XCircleIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SubagentRowStatus = 'running' | 'finished' | 'failed' | 'cancelled' | 'exited'

export const SUBAGENT_STATUS_LABEL: Record<SubagentRowStatus, string> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  exited: 'Agent exited'
}

/** A distinct icon per state, never colour alone (WCAG 2.1 AA): spinner, check, cross, stop
 * (cancelled), unplug (exited). `finished`'s word is `sr-only` (decision 14): a finished
 * reviewer may still have returned a FAIL verdict, so a quiet icon-plus-duration row, not a
 * loud "Finished" claim, avoids overstating the result; every other state's word stays visible
 * (never colour alone). */
export function SubagentStatusIcon({ status }: { status: SubagentRowStatus }) {
  const className = 'size-3.5 shrink-0'
  return (
    <>
      {status === 'running' && <LoaderCircleIcon aria-hidden className={cn(className, 'animate-spin text-state-working')} />}
      {status === 'finished' && <CheckCircle2Icon aria-hidden className={cn(className, 'text-state-idle')} />}
      {status === 'failed' && <XCircleIcon aria-hidden className={cn(className, 'text-severity-error')} />}
      {status === 'cancelled' && <CircleStopIcon aria-hidden className={cn(className, 'text-muted-foreground')} />}
      {status === 'exited' && <UnplugIcon aria-hidden className={cn(className, 'text-muted-foreground')} />}
      <span className={status === 'finished' ? 'sr-only' : undefined}>{SUBAGENT_STATUS_LABEL[status]}</span>
    </>
  )
}

/** Maps the chat transcript's own `kind: 'subagent'` row status words (`running`/`done`/
 * `error`/`cancelled`/`exited`) onto the shared vocabulary above; `SubagentSummary`'s own status
 * already uses the shared words directly and needs no mapping. Three call sites need this in
 * lockstep (`SubagentRow`, the stage group roll-up, the chain roll-up): if any one drifted, the
 * same call could read "Finished" on one surface and "Failed" on another. */
export function chatRowStatus(status: 'running' | 'done' | 'error' | 'cancelled' | 'exited'): SubagentRowStatus {
  if (status === 'done') return 'finished'
  if (status === 'error') return 'failed'
  return status
}

/** The roll-up counts decision 15 asks for: cancelled counted on its own, never folded into
 * failed. Shared by the stage group header and the chain summary line (groupSubagentStages.ts). */
export function summarizeSubagentStatuses(statuses: SubagentRowStatus[]): Record<SubagentRowStatus, number> {
  const counts: Record<SubagentRowStatus, number> = { running: 0, finished: 0, failed: 0, cancelled: 0, exited: 0 }
  for (const status of statuses) counts[status] += 1
  return counts
}
