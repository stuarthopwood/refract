// Issue #509 (PLAN.md row A2g) requirement 1: pure, side-effect-free, and shared (not renderer- or
// main-only) so both the session-list row button / ChatPane banner (renderer) and the
// `sessions.resume` IPC handler's own server-side re-check (main, quality gate 2026-10-08: never
// trust a client-computed "it's safe to resume" without confirming it again where the actual
// restart happens) read the exact same rule.
//
// Shown/allowed only when the agent was terminated unexpectedly -- `agent-exited` this run, or a
// persisted (file-tail) `terminatedUnexpectedly` signal from #510 for a Session that died
// mid-turn in an earlier run. Never for `worktree-missing` (its own dedicated Recreate/Archive/
// Delete actions) or `start-failed` (explicitly out of scope until #449 is fully landed, not just
// in `verify`).
import type { SessionStatus } from './model';
import type { SessionRuntimeView } from './ipc';

export function canResumeSession(
  status: SessionStatus,
  stopReason: SessionRuntimeView['stopReason'],
  terminatedUnexpectedly: boolean | undefined,
): boolean {
  if (status !== 'stopped') return false;
  if (stopReason === 'worktree-missing' || stopReason === 'start-failed') return false;
  return stopReason === 'agent-exited' || !!terminatedUnexpectedly;
}
