// Genuinely-empty detection (docs/DESIGN.md "Hide new-session MCP-mount dump", Stuart
// 2026-10-04; narrowed per code/test-reviewer round 2): the only transcript item a brand-new
// agent process can produce before any real exchange is a `notice` (OMP's own unsolicited
// startup banner -- a `command_output`/`notice` frame, same mechanism a user-run slash
// command's own output uses, lists every mounted MCP tool verbatim). Hiding *every* `notice`
// until a non-notice item exists was too broad: it also hid a start-failure notice, a rejected
// first prompt's error notice, and a slash command's own output when run as the very first
// action in a new Session -- none of which is the startup banner, and DESIGN.md's "never a
// silent no-op" rule for slash commands means the last of those must always be visible. A
// `notice` now counts as "conversation started" unless it is BOTH an info/warning-level notice
// (an error is always a real outcome, never the unsolicited banner) AND tagged
// `STARTUP_NOTICE_PREFIX` (`transcript.ts`'s `applyFrame`, keyed off `SessionAgent.hasUserActed`
// -- the one case that is unambiguously the agent's own startup dump, not something the user
// did). Suppressed notice(s) stay in `items` (never dropped -- they render normally the moment
// real content exists) but are not displayed, replaced by a neutral placeholder instead.
//
// Issue #618: exported (was a private inline computation) so a predicate this precise ("a notice
// counts unless it is the unsolicited startup banner") is defined once. Issue #672: `ChatPane.tsx`
// no longer reads this directly -- `Transcript.tsx` (this module's only remaining importer) uses
// it for `hasConversationStarted` (gates whether "Ready…" can show at all) and for `dimTranscript`
// (whether the Session-start notice overlays dimmed history or empty space); the old
// `showInline`/`conversationStarted` split in `ChatPane.tsx` this comment used to describe is
// gone along with the `inline` notice variant it existed for.
//
// Split out of `Transcript.tsx` (not inline there, issue #554 gate round 1, M5) to keep that
// file within this build's 600-line cap with no slack.
import { STARTUP_NOTICE_PREFIX, type TranscriptItem } from '../../../shared/model';

export function isConversationStarted(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => item.kind !== 'notice' || item.level === 'error' || !item.id.startsWith(STARTUP_NOTICE_PREFIX));
}
