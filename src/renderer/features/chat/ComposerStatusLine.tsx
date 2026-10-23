// #564 (spec 004 FR-023, supersedes FR-001's "chip row... Approval mode pill first"): the thin
// status line between the transcript and the message box, replacing the old chip row. The
// Approval mode pill no longer lives here -- it moved into the composer box's own bottom row
// (spec 001 FR-065, ApprovalModePill.tsx, rendered from MessageInput.tsx directly) -- so this
// component owns only the Settings-gated readout chips themselves (spec 004 FR-002 to FR-007,
// FR-021), each independently hiding itself when its own data is null, exactly as before.
//
// Full chat width (Stuart, 2026-10-15: "as the mock's telemetry dock does"), `flex-wrap` so it
// wraps onto a further line at any window width rather than ever hiding or overlapping the box
// below it (spec 004 FR-009, unchanged), and `tabular-nums` on the row so every chip's own
// figures align in a column without each chip having to opt in individually. The Current time
// chip, when enabled, renders last with `ml-auto` so it sits at the row's right end (Stuart,
// 2026-10-15); no branch name and no mode dot (same decision, 2026-10-15 mockup-stories review:
// the Session row already shows the branch, spec 004 data-model.md, so repeating either here
// would be redundant). When no chip is enabled or meaningful, the container collapses to true
// zero height via `empty:hidden` (gate round 5, Visual Medium: a flex container with no React
// children still has no DOM children either, so `:empty` matches and the parent's own `gap-2`
// no longer adds a lopsided gap above an invisible row) -- never a visible empty bar, since the
// one guaranteed item (the Approval pill) is gone.
import { useSettingsStore } from '@/state'
import type { RefObject } from 'react'
import {
  AdvisorChip,
  ChangesChip,
  CurrentTimeChip,
  PullRequestChip,
  SubagentsChip,
  TodoProgressChip,
  TurnTimeChip
} from './readout/ReadoutChips'
import { ContextUsageChip } from './readout/ContextUsageChip'
import { LongConversationChip } from './LongConversation'

export function ComposerStatusLine({ sessionId, textareaRef }: { sessionId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const sessionReadout = useSettingsStore((s) => s.settings.sessionReadout)
  return (
    <div data-slot="composer-status-line" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 empty:hidden tabular-nums">
      {sessionReadout.changes && <ChangesChip sessionId={sessionId} />}
      {sessionReadout['todo-progress'] && <TodoProgressChip sessionId={sessionId} />}
      {sessionReadout['context-usage'] && <ContextUsageChip sessionId={sessionId} />}
      {sessionReadout['turn-time'] && <TurnTimeChip sessionId={sessionId} />}
      {sessionReadout.subagents && <SubagentsChip sessionId={sessionId} />}
      {sessionReadout['pull-request'] && <PullRequestChip sessionId={sessionId} />}
      {/* Gate round 1 decision (D, Skippy, delegated by Stuart 2026-10-18), corrected gate
          round 3 (D): last in this group, right before the `ml-auto` Current time chip -- a
          fixed ORDER relative to its siblings, not a fixed POSITION. This row already has no
          fixed slots: `TurnTimeChip`/`SubagentsChip`/etc. above it already appear and
          disappear live with real turn/subagent data, shifting every chip after them sideways
          regardless of where Advisor itself sits -- this placement only fixes where Advisor
          falls in that same already-shifting row, not a guarantee against the shift itself. */}
      <AdvisorChip sessionId={sessionId} textareaRef={textareaRef} />
      <LongConversationChip sessionId={sessionId} />
      {sessionReadout['current-time'] && <CurrentTimeChip className="ml-auto" />}
    </div>
  )
}
