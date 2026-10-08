// Issue #509 (PLAN.md row A2g) quality-gate fix: pulled out of `ipc/sessions.ts` so it is
// unit-testable without Electron, and rewritten as an allow-list (never a deny-list) -- a
// deny-list fails OPEN for any future `stopReason` value nobody has excluded yet, where an
// allow-list fails closed instead.
import type { SessionRuntimeView } from '../../shared/ipc';

/** `sessions.open` auto-starts a stopped Session only when nothing is wrong with the agent
 * itself: never started this run, or stopped on request (`SessionAgent.onExit`'s requested
 * branch uses `stopReason: 'not-started'` for both). `worktree-missing` also still auto-starts
 * here (unchanged; T043 owns that state's dedicated Recreate/Archive/Delete actions, not this
 * gate). `agent-exited` and `start-failed` must NOT auto-start (FR-034): the crashed/failed agent
 * stays visibly stopped, with its `stopReason`/`stopDetail` (including the stderr tail), until the
 * user explicitly asks `sessions.recover`.
 *
 * Issue #509 requirement 6 ("normal resume stays as it is ... no automatic prompt") also excludes
 * a `not-started`/`undefined` Session whose Conversation tail shows it died mid-turn (issue
 * #510's `terminatedUnexpectedly`): without this, opening it would silently auto-start and lose
 * the chance to Resume with the default instruction before the banner (and its Resume button)
 * ever had a moment to show. `worktree-missing` is deliberately exempt from this extra exclusion
 * -- its own dedicated actions apply regardless of what the tail happens to show. */
export function canAutoStart(stopReason: SessionRuntimeView['stopReason'], terminatedUnexpectedly: boolean): boolean {
  const normallyAllowed = stopReason === undefined || stopReason === 'not-started' || stopReason === 'worktree-missing';
  if (!normallyAllowed) return false;
  if (stopReason !== 'worktree-missing' && terminatedUnexpectedly) return false;
  return true;
}
