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
export function computeTurnEnd(turnItems: TranscriptItem[], receivedAt: Record<string, number>): number | undefined {
  let maxEnd: number | undefined
  for (const item of turnItems) {
    if (item.kind === 'user') continue
    if (item.kind === 'notice' && item.id.startsWith(COMMAND_OUTPUT_NOTICE_PREFIX)) continue
    const end = receivedAt[item.id] ?? itemEndTime(item)
    if (end != null && (maxEnd === undefined || end > maxEnd)) maxEnd = end
  }
  return maxEnd
}
