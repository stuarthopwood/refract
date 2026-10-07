// Assembles the chip row's live SessionReadout bundle (spec 004 FR-002 to FR-008, FR-021,
// data-model.md "SessionReadout"). Called by SessionAgent.scheduleReadoutUpdate() after any
// state change that could move a readout (a tool call ending, a turn starting/ending, a
// get_state sync); itself only does the `diffStat` lookup now -- the pull-request lookup moved
// out to `SessionAgent.refreshPullRequest` (spec 004 remediation, HIGH: a `gh pr list` network
// call on every readout trigger, including every `tool_execution_update` during a subagent-heavy
// turn, could hammer Stuart's own GitHub API rate limit; see that method's own doc comment for
// where it actually runs instead) -- so this stays async only for `diffStat`, and
// scheduleReadoutUpdate's own in-flight guard keeps two calls for one Session from overlapping,
// never this module's concern.

import { diffStat } from '../git/diffStat';
import type { Session, SessionReadout, SubagentSummary } from '../../shared/model';

export interface ReadoutState {
  turnStartedAt: number | null;
  subagents: SubagentSummary[];
  /** `get_state().contextUsage`, when the most recent sync reported one (FINDINGS item 34). */
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  /** True once at least one `get_state` has synced this run; before that, `contextUsage`/
   * `todoProgress` stay at `previous`'s value (typically `null`, hidden) rather than jumping to
   * `'not-available'` -- no reading was ever expected yet. */
  stateSynced: boolean;
  /** `get_state().todoPhases` (FINDINGS item 35), when the most recent sync reported one. */
  todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
  /** `SessionAgent.cachedPullRequest` (spec 004 remediation, HIGH): already resolved and
   * retention-adjusted by `refreshPullRequest` -- passed straight through to the built
   * `SessionReadout` below, never looked up fresh here. */
  pullRequest: SessionReadout['pullRequest'];
}

/** Builds a fresh `SessionReadout` from `previous` (for retention) and the current `state`
 * (data-model.md's retention rule: `changes`/`contextUsage`/`pullRequest` keep their last
 * non-null reading on a transient failure; `turnTime` is always derived fresh from
 * `state.turnStartedAt`, never meaningful outside a running turn; `subagentCount` is always
 * derived fresh from `state.subagents`, meaningful for the whole current turn including after
 * it settles, until the next turn clears the underlying list). */
export async function assembleReadout(session: Session, previous: SessionReadout, state: ReadoutState): Promise<SessionReadout> {
  // `sessions.diffStat`'s own `null` covers both "missing worktree/Base branch" (spec 001
  // FR-039) and an internal failure/timeout; both map to this spec's `'not-available'` (FR-002)
  // -- a definitive state, not a momentary blip, so it is never retained over a stale count.
  const diffStatResult = await diffStat(session.worktreePath, session.baseBranch);
  const changes = diffStatResult ?? 'not-available';

  const contextUsage = state.contextUsage
    ? { usedTokens: state.contextUsage.tokens, windowTokens: state.contextUsage.contextWindow, percent: state.contextUsage.percent }
    : state.stateSynced
      ? ('not-available' as const) // a sync happened but the agent never reported it (FR-003's own escape hatch)
      : previous.contextUsage; // no sync yet this run; keep whatever the last run (or null) had

  // FR-007/T008: the count reflects the *current* turn's subagents -- it MUST persist after
  // that turn settles (a developer still asking "what did it delegate to" after the fact) and
  // is only cleared by the *next* turn starting (SessionAgent.ts resets `runtime.subagents` on
  // `agent_start`), never by `turnStartedAt` going back to `null` on settle -- gating on it here
  // too (as an earlier draft of this function did) hid the chip the instant the turn finished,
  // before the next turn had a chance to clear the underlying list (caught live: quickstart
  // Story 1's multi-subagent-turn check, the chip vanished right as the final reply landed).
  const activeSubagents = state.subagents.filter((s) => s.status !== 'failed');
  // Issue #489: a seeded 'exited' entry (an attach/resume orphan whose process is confirmed
  // gone, never a failure of the subagent's own work -- SessionAgent.seedOrphanedSubagents)
  // folds into the same bucket as 'finished' here; the chip's aggregate count has no third
  // bucket, and both read as "not running any more" to it. The Subagents panel still shows the
  // distinct 'exited' state per row (SubagentPanel.tsx).
  const subagentCount =
    state.subagents.length > 0
      ? {
          running: activeSubagents.filter((s) => s.status === 'running').length,
          finished: activeSubagents.filter((s) => s.status === 'finished' || s.status === 'exited').length,
        }
      : null;

  const todoProgress = (() => {
    if (!state.todoPhases) return null;
    const tasks = state.todoPhases.flatMap((phase) => phase.tasks);
    return tasks.length > 0 ? { done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length } : null;
  })();

  return {
    changes,
    contextUsage,
    turnTime: state.turnStartedAt !== null ? { startedAt: state.turnStartedAt } : null,
    pullRequest: state.pullRequest,
    subagentCount,
    todoProgress,
  };
}
