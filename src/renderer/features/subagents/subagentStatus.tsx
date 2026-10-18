// Shared subagent status vocabulary (issue #563 decision 14): one status-icon map reused by the
// chat transcript's SubagentRow, the new per-stage group row and subagent chain row, and the
// Subagent panel's tree -- so a running vs finished vs cancelled subagent never reads
// differently depending which of those surfaces shows it. Extends the icon set
// `SubagentPanel.tsx`'s own (pre-#563) `SubagentStateIcon` (running/finished/failed/exited) with
// `cancelled` (decision 15, split out of failed: a cancel/abort is not a failure).
import { cn } from '@/lib/utils'
import { STATUS_GLYPH, type StatusGlyphKey } from '../chat/statusGlyph'

export type SubagentRowStatus = 'running' | 'finished' | 'failed' | 'cancelled' | 'exited'

export const SUBAGENT_STATUS_LABEL: Record<SubagentRowStatus, string> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  exited: 'Agent exited'
}

// Gate round 1 (#570, G909Code Medium, decision 3 "one status map"): the icon/colour pairs
// below come from `statusGlyph.ts`'s shared `STATUS_GLYPH` table -- the one this module chose
// first (issue #563) and `toolStatus.tsx`'s own `StatusIcon` now reads too, instead of a second
// hand-written copy that could drift apart from this one.
//
// Issue #941: `finished` maps to the chromatic `success-done` key, not `neutral-done` -- EVERY
// consumer of this module (`SubagentRow`, the Stage group header, the chain rows, the
// Subagent panel tree) is one of the surfaces #941 asks for green on; `toolStatus.tsx` is the
// separate module that keeps tool rows/groups neutral, untouched by this change.
const GLYPH_KEY_BY_STATUS: Record<SubagentRowStatus, StatusGlyphKey> = {
  running: 'running',
  finished: 'success-done',
  failed: 'error',
  cancelled: 'cancelled',
  exited: 'neutral-muted'
}

/** Issue #941: true for the one status whose icon AND owning name/label text both switch to
 * the success token (never any other state) -- derived from the single `GLYPH_KEY_BY_STATUS`
 * map above so the colour and the "is this the green one" question can never drift apart.
 * Callers that render a Stage's own label or an agent's own name (`ChainAgentEntry`,
 * `StageGroupRow`, the Subagent panel tree row) apply `SUBAGENT_SUCCESS_TEXT_CLASS` when this
 * is true; the icon itself already gets its colour from `STATUS_GLYPH` with no extra wiring. */
export function isSubagentSuccessStatus(status: SubagentRowStatus): boolean {
  return GLYPH_KEY_BY_STATUS[status] === 'success-done'
}

/** The Tailwind class issue #941's "green text" half applies to a finished agent/Stage's own
 * name or label, alongside the icon colour `STATUS_GLYPH` already supplies -- the same
 * `--severity-success` token, so the two never read as two different greens. */
export const SUBAGENT_SUCCESS_TEXT_CLASS = 'text-severity-success'

/** Issue #1008 item 1: true for the one status whose icon AND owning Stage label both switch to
 * the error token -- derived from the same `GLYPH_KEY_BY_STATUS` map `isSubagentSuccessStatus`
 * reads, so the two colour questions never drift apart. `ToolRow.tsx`'s own failed-call label
 * already applies `text-severity-error` this same way (`item.status === 'error'`); callers here
 * apply `SUBAGENT_ERROR_TEXT_CLASS` when this is true, alongside the icon colour `STATUS_GLYPH`
 * already supplies. */
export function isSubagentFailedStatus(status: SubagentRowStatus): boolean {
  return GLYPH_KEY_BY_STATUS[status] === 'error'
}

/** The Tailwind class issue #1008's "failed Stage label" fix applies to a failed Stage's own
 * label, the same `--severity-error` token `ToolRow.tsx`'s own failed-call label already uses. */
export const SUBAGENT_ERROR_TEXT_CLASS = 'text-severity-error'

/** Issue #1008: the Stage label's own text-colour half (`StageGroupRow`'s label,
 * `ChainStageLine`'s jump button -- `SubagentChainRow.tsx`), green when finished, red when
 * failed, `undefined` for every other state -- the one call both sites share so the two text
 * colours (and the running/cancelled/exited "stay neutral" default) can never drift apart. */
export function subagentStatusTextClass(status: SubagentRowStatus): string | undefined {
  if (isSubagentSuccessStatus(status)) return SUBAGENT_SUCCESS_TEXT_CLASS
  if (isSubagentFailedStatus(status)) return SUBAGENT_ERROR_TEXT_CLASS
  return undefined
}

/** The icon-only markup shared by `SubagentStatusIcon` and `SubagentStatusGlyph` below: a
 * distinct icon per state, never colour alone (WCAG 2.1 AA): spinner, check, cross, stop
 * (cancelled), unplug (exited). */
function SubagentStatusGlyphIcons({ status }: { status: SubagentRowStatus }) {
  const { Icon, className } = STATUS_GLYPH[GLYPH_KEY_BY_STATUS[status]]
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />
}

/** A distinct icon per state, never colour alone (WCAG 2.1 AA). `finished`'s word is `sr-only`
 * (decision 14): a finished reviewer may still have returned a FAIL verdict, so a quiet
 * icon-plus-duration row, not a loud "Finished" claim, avoids overstating the result; every
 * other state's word stays visible (never colour alone). For the two inline call sites that lay
 * this out in their own flex row (`SubagentPanel.tsx`'s tree row, `SubagentChainRow.tsx`'s
 * `ChainAgentEntry`/`ChainStageLine`) -- NEVER for a `CollapsedLine` `icon=` slot, whose fixed
 * `size-4` box (#565 decision 7) the visible word would overflow and paint over the label; use
 * `SubagentStatusGlyph` there instead. */
export function SubagentStatusIcon({ status }: { status: SubagentRowStatus }) {
  return (
    <>
      <SubagentStatusGlyphIcons status={status} />
      <span className={cn('shrink-0 whitespace-nowrap', status === 'finished' && 'sr-only')}>{SUBAGENT_STATUS_LABEL[status]}</span>
    </>
  )
}

/** Same icon markup as `SubagentStatusIcon`, but the status word is ALWAYS `sr-only`: for any
 * `CollapsedLine` `icon=` slot (a fixed `size-4` box, #565 decision 7, too narrow for an inline
 * word), whose caller renders the visible word itself in the `meta` slot instead, ahead of the
 * duration. */
export function SubagentStatusGlyph({ status }: { status: SubagentRowStatus }) {
  return (
    <>
      <SubagentStatusGlyphIcons status={status} />
      <span className="sr-only">{SUBAGENT_STATUS_LABEL[status]}</span>
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
