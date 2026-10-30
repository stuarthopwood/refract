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

export function stillEligibleAfterResume(result: Result<SessionSnapshot>, archived: boolean): boolean {
  if (!result.ok) return result.error.code !== 'prompt-failed';
  return canResumeSession(result.value.runtime.status, result.value.runtime.stopReason, result.value.runtime.terminatedUnexpectedly, archived);
}
