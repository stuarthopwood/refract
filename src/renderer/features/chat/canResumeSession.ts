// Issue #509 (PLAN.md row A2g) requirement 1: pure, side-effect-free so it is trivially shared
// between the session-list row button and the ChatPane stop banner's Resume button without
// pulling either one's heavier component module into the other's import graph.
//
// Shown only when the agent was terminated unexpectedly -- `agent-exited` this run, or a
// persisted (file-tail) `terminatedUnexpectedly` signal from #510 for a Session that died
// mid-turn in an earlier run. Never for `worktree-missing` (its own dedicated Recreate/Archive/
// Delete actions) or `start-failed` (explicitly out of scope until #449 is fully landed, not just
// in `verify`).
export function canResumeSession(
  status: 'idle' | 'working' | 'needs-you' | 'stopped',
  stopReason: string | undefined,
  terminatedUnexpectedly: boolean | undefined,
): boolean {
  if (status !== 'stopped') return false;
  if (stopReason === 'worktree-missing' || stopReason === 'start-failed') return false;
  return stopReason === 'agent-exited' || !!terminatedUnexpectedly;
}
