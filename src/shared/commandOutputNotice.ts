// Issue #938 item 4: split out of model.ts to stay within the 600-line file-size cap
// (scripts/check-file-size.mjs).

/** `id` prefix for a `notice` built specifically from a real, post-startup `command_output`
 * frame (issue #938 item 4): a user-run slash command's own reply, which otherwise joined the
 * PREVIOUS turn's own activity block and stretched its total time (`Transcript.tsx`'s
 * `computeTurnEnd`, FR-046) whenever it arrived after that turn had already settled -- a command
 * reply is not part of any turn's own timing, so `computeTurnEnd` skips any notice carrying this
 * prefix entirely (neither its `itemEndTime` nor its live `receivedAt` arrival time ever counts).
 * Distinct from `STARTUP_NOTICE_PREFIX` (model.ts): that one marks the unsolicited startup
 * banner (suppressed from view); this one marks a real, shown reply (never suppressed, only
 * excluded from the turn-time sum). A plain `notice` frame (not `command_output`) keeps the
 * ordinary `notice-N` id and still counts, since only a command's own output is excluded. */
export const COMMAND_OUTPUT_NOTICE_PREFIX = 'command-output:';
