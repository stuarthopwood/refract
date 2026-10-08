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
// in `verify`). Quality-gate fix (cycle 5, 2026-10-08): requirement 1 also says "not for ...
// archived Sessions" -- an archived Session whose agent crashed this run before being archived
// keeps `stopReason: 'agent-exited'` (archive's own `shutdown()` is a no-op with no live
// process), which this function would otherwise show Resume for in the Archived list.
import type { SessionStatus } from './model';
import type { Result, SessionRuntimeView, SessionSnapshot } from './ipc';

export function canResumeSession(
  status: SessionStatus,
  stopReason: SessionRuntimeView['stopReason'],
  terminatedUnexpectedly: boolean | undefined,
  archived: boolean,
): boolean {
  if (status !== 'stopped') return false;
  if (archived) return false;
  if (stopReason === 'worktree-missing' || stopReason === 'start-failed') return false;
  return stopReason === 'agent-exited' || !!terminatedUnexpectedly;
}

// Issue #509 quality-gate fix (cycle 7, 2026-10-08, a11y-auditor, Medium): a Resume button's
// own pending-focus flag (SessionList.tsx's `resumeFocusPendingRef`) must only be cleared when
// the Session is STILL resumable after the call -- a restart failure (`result.ok === true`, the
// returned snapshot's own `runtime.status` still `'stopped'`, now e.g. `stopReason:
// 'start-failed'`) flips this same `canResumeSession` check to false exactly like a genuine
// success does, so the row's stranded-focus effect still needs to fire and move focus onto the
// open button once the Resume button disappears. Clearing the flag unconditionally on ANY
// failure (the behaviour before this fix) left focus stuck on `<body>` for that case. A hard
// failure (`result.ok === false`) never changes the Session's own resumability, so it always
// reports eligible (clear).
export function stillEligibleAfterResume(result: Result<SessionSnapshot>, archived: boolean): boolean {
  if (!result.ok) return true;
  return canResumeSession(result.value.runtime.status, result.value.runtime.stopReason, result.value.runtime.terminatedUnexpectedly, archived);
}
