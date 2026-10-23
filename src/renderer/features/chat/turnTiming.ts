import { COMMAND_OUTPUT_NOTICE_PREFIX } from '../../../shared/commandOutputNotice'
import type { TranscriptItem } from '../../../shared/model'

// Split out of Transcript.tsx to stay within the 600-line file-size cap (scripts/check-file-
// size.mjs). Pure turn-timing helpers, no JSX or component state.

/** Every item's own best end-time estimate, read from whichever kind-specific timing field it
 * has (T076): absent for a kind with none at all (`assistant-text`, `notice`, `request`), which
 * is exactly why `receivedAt` (live arrival time) is tried first by the caller. */
function itemEndTime(item: TranscriptItem): number | undefined {
  if (item.kind === 'tool' || item.kind === 'subagent') {
    return item.startedAt != null && item.durationMs != null ? item.startedAt + item.durationMs : undefined
  }
  if (item.kind === 'thinking') return item.endedAt
  if (item.kind === 'user' || item.kind === 'agent-message') return item.at
  return undefined
}

// Excludes the turn's own leading `user` item: its `at` always exists (even a sentinel `0` for a
// history entry with no usable timestamp, FR-046), so including it would make `computeTurnEnd`
// return a defined value for every turn and defeat the "omitted when no item carries usable
// timing" rule below -- a reopened Conversation with no real timing would show "0s" instead of
// nothing.
// Issue #938 item 4: a command-output notice's id carries `COMMAND_OUTPUT_NOTICE_PREFIX` (Rust's
// `apply_frame_items`) -- a user-run slash command's own reply is not part of any turn's own
// timing, so it is skipped here exactly like the turn's own leading `user` item, taking neither
// its live `receivedAt` arrival time nor any `itemEndTime` (notices have none anyway) into the
// turn's total. The reply itself still renders normally (never suppressed, unlike a startup
// notice); only the turn-time MATH leaves it out, so a command run after a turn settles no
// longer stretches that turn's own shown elapsed time (22s becoming "1m 17s" in the #917 live
// screenshots).
function countableItemEnd(item: TranscriptItem, receivedAt: Record<string, number>): number | undefined {
  if (item.kind === 'user') return undefined
  if (item.kind === 'notice' && item.id.startsWith(COMMAND_OUTPUT_NOTICE_PREFIX)) return undefined
  return receivedAt[item.id] ?? itemEndTime(item)
}

export function computeTurnEnd(turnItems: TranscriptItem[], receivedAt: Record<string, number>): number | undefined {
  let maxEnd: number | undefined
  for (const item of turnItems) {
    const end = countableItemEnd(item, receivedAt)
    if (end != null && (maxEnd === undefined || end > maxEnd)) maxEnd = end
  }
  return maxEnd
}

/** True when this turn has gained a REAL (non-`user`, non-command-output) item whose own end
 * (same `receivedAt`-first, `itemEndTime`-fallback rule `computeTurnEnd` uses) is newer than
 * `settledEnd` -- round 2 gate finding (Main, 2026-10-18): `TurnTotalLine` uses this to tell a
 * genuine resumption of the SAME turn (an async subagent result, an advisor follow-up, a retry
 * after compaction) apart from an unrelated bare command's own reply, which flips the session
 * back to "working" for this still-last turn without ever adding an item this function would
 * count (a command-output notice is excluded exactly like `computeTurnEnd` excludes it) -- so the
 * turn's own shown time resumes live-ticking only for the former, never stretches for the
 * latter. `receivedAt` is set the moment an item first arrives (not only once it finishes), so a
 * still-in-progress resumed item (no `itemEndTime` yet) is already detected via its own
 * `receivedAt` entry, not held back until it completes. */
export function hasNewerRealActivity(turnItems: TranscriptItem[], receivedAt: Record<string, number>, settledEnd: number): boolean {
  return turnItems.some((item) => {
    const end = countableItemEnd(item, receivedAt)
    return end != null && end > settledEnd
  })
}
