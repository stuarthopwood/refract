// Assembles the chip row's live SessionReadout bundle (spec 004 FR-002 to FR-008, FR-021,
// data-model.md "SessionReadout"). Called by SessionAgent.scheduleReadoutUpdate() after any
// state change that could move a readout (a tool call ending, a turn starting/ending, a
// get_state sync, or the pull-request poll timer); itself does the git/gh lookups (diffStat,
// pullRequestForBranch), so it is async -- scheduleReadoutUpdate's own in-flight guard keeps two
// calls for one Session from overlapping, never this module's concern.

import { diffStat } from '../git/diffStat';
import { pullRequestForBranch } from '../git/github';
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
}

/** Builds a fresh `SessionReadout` from `previous` (for retention) and the current `state`
 * (data-model.md's retention rule: `changes`/`contextUsage`/`pullRequest` keep their last
 * non-null reading on a transient failure; `turnTime`/`subagentCount` are always derived fresh
 * from `state.turnStartedAt`/`state.subagents`, never meaningful outside a running turn). */
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

  // Judgment call (data-model.md's retention rule vs spec.md's edge-case wording, both ambiguous
  // together): a clean lookup that finds no open PR for this branch (a PR closed/merged, or a
  // branch that never had one) actively hides the chip (quickstart Story 1 point 6, "Switch to a
  // branch with no pull request... the chip disappears"); only a genuinely indeterminate lookup
  // (gh missing, offline, rate limited, no recognisable remote) retains the previous reading,
  // per data-model.md's "a lookup momentarily fails" wording.
  const lookup = await pullRequestForBranch(session.worktreePath, session.branch);
  const pullRequest = lookup.status === 'found' ? lookup.pr : lookup.status === 'none' ? null : previous.pullRequest;

  const activeSubagents = state.subagents.filter((s) => s.status !== 'failed');
  const subagentCount =
    state.turnStartedAt !== null && state.subagents.length > 0
      ? {
          running: activeSubagents.filter((s) => s.status === 'running').length,
          finished: activeSubagents.filter((s) => s.status === 'finished').length,
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
    pullRequest,
    subagentCount,
    todoProgress,
  };
}
