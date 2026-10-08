// Issue #510 quality-gate fix (cycle 3, 2026-10-08): the guard `SessionAgent.onExit`'s crash
// branch uses to decide whether its own "agent-exited" verdict (computed after an awaited tail
// read) is still the right thing to apply, pulled into its own pure, testable function -- see
// `SessionAgent.ts`'s own `lifeEpoch` field doc comment for the race this closes. A concurrent
// `launch()` attempt for the SAME exit can easily outrun this await (its own handshake/attach
// failure handling is synchronous, no file read involved); without this guard, a crash's
// generic verdict used to unconditionally overwrite whatever `launch()` had already recorded
// (start-failed with its stderr tail, worktree-missing, not-started), and, through #585's
// `canResumeSession`, wrongly offered Resume instead of #449's own Retry/Start-new actions.
import type { SessionStatus } from '../../shared/model';

/** `statusNow`/`lifeEpochNow` are read at the moment of the check (after the await); `epochAtExit`
 * is the life this exit event itself belongs to, captured before the await. Returns `false`
 * (skip the verdict) when something more authoritative already moved the Session to `stopped`
 * for this same life (`launch()`'s own synchronous failure path, or a requested-stop bail), or
 * when an entirely newer life has since started (and possibly already succeeded). */
export function shouldApplyCrashExitVerdict(statusNow: SessionStatus, lifeEpochNow: number, epochAtExit: number): boolean {
  return statusNow !== 'stopped' && lifeEpochNow === epochAtExit;
}
