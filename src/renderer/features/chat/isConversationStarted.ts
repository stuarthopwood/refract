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
// Gate-fix (code/a11y/verif High, round 3, Issue #618): exported (was a private inline
// computation) so `ChatPane.tsx` can read the SAME predicate against the SAME transcript-store
// items, instead of deciding where the start notice goes from its own, narrower `hasHistory`
// alone. `hasHistory` (`session.currentConversation !== null`) only flips true at a settle,
// which left a start that fails or crashes mid-first-turn -- real items already on screen,
// `recordStartFailure`'s own error notice among them -- with NO notice and NO Keep
// waiting/Cancel at all on the next Retry/Recover, because the centred placement required
// `!hasConversationStarted` and the inline placement required `hasHistory`, and neither was
// true. See `ChatPane.tsx`'s own `conversationStarted`/`showInline` for the fix.
//
// Split out of `Transcript.tsx` (not inline there, issue #554 gate round 1, M5) to keep that
// file within this build's 600-line cap with no slack -- re-exported from `Transcript.tsx` so
// `ChatPane.tsx`'s existing `from './Transcript'` import keeps working unchanged.
import { STARTUP_NOTICE_PREFIX, type TranscriptItem } from '../../../shared/model';

export function isConversationStarted(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => item.kind !== 'notice' || item.level === 'error' || !item.id.startsWith(STARTUP_NOTICE_PREFIX));
}
