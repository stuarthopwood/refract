import { CheckIcon, Loader2Icon, UnplugIcon, XIcon } from 'lucide-react'

// Quality-gate remediation (Low, round 2): split out of `ToolRow.tsx` so it and
// `ToolCallDialog.tsx` -- which previously imported these three back out of `ToolRow.tsx` while
// `ToolRow.tsx` itself imported `ToolCallDialog` for the "View full call" link -- no longer form
// a circular import. Both files now depend one-way on this shared module instead.

export type RowStatus = 'running' | 'done' | 'error' | 'exited' | 'interrupted'

// One source of truth for how a duration renders (`ToolRow.tsx`'s row `meta`,
// `ToolCallDialog.tsx`'s Formatted-tab header), not a second copy.
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// Issue #457 quality-gate fix (a11y, Medium): exported so `Transcript.tsx` can reuse the exact
// same status word for a hidden-but-running `ToolGroup`'s one-line sr-only progress placeholder
// (`isHiddenRow`'s `'sr-only'` case) that `StatusIcon` below already uses for its own sr-only
// text -- one source of truth for the five status words, not two copies that could drift apart.
export function toolStatusLabel(status: RowStatus): string {
  return status === 'running'
    ? 'Running'
    : status === 'error'
      ? 'Failed'
      : status === 'exited'
        ? 'Agent exited'
        : status === 'interrupted'
          ? 'Interrupted'
          : 'Done'
}

// A distinct icon shape per status (never colour alone, T080/WCAG 2.1 AA): spinner, check, cross,
// unplug (`'exited'`, issue #489 gate finding 4 -- matches `SubagentPanel.tsx`'s own icon/wording
// for the same state so the chat row and the panel row never disagree; `'interrupted'`, issue
// #510 slice 3 -- the same family, a tool call left with no result because its Conversation's
// tail shows the writing process is gone, reusing the unplug shape so neither reads as "done").
// Reused by `ToolCallDialog.tsx`'s own small header (#628 Formatted tab): the one place a status
// renders as an icon, so the two surfaces can never disagree.
export function StatusIcon({ status }: { status: RowStatus }) {
  const label = toolStatusLabel(status)
  return (
    <>
      {status === 'running' && <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />}
      {status === 'error' && <XIcon className="size-3.5 shrink-0 text-destructive" />}
      {(status === 'exited' || status === 'interrupted') && <UnplugIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      {status === 'done' && <CheckIcon className="size-3.5 shrink-0 text-state-working" />}
      <span className="sr-only">{label}</span>
    </>
  )
}
