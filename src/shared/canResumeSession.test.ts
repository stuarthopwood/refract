// Issue #509 (PLAN.md row A2g) requirement 1: regression coverage for when the Resume button shows
// (and server-side, when `sessions.resume` allows it) and when it must not.
import { describe, it, expect } from 'vitest';
import { canResumeSession, stillEligibleAfterResume } from './canResumeSession';
import type { SessionStatus } from './model';
import type { Result, SessionRuntimeView, SessionSnapshot } from './ipc';

describe('canResumeSession', () => {
  it.each<[SessionStatus, SessionRuntimeView['stopReason'], boolean | undefined, boolean, boolean]>([
    ['stopped', 'agent-exited', false, false, true],
    ['stopped', 'agent-exited', undefined, false, true],
    ['stopped', 'not-started', true, false, true],
    ['stopped', undefined, true, false, true],
    ['stopped', 'not-started', false, false, false],
    ['stopped', 'not-started', undefined, false, false],
    ['stopped', undefined, undefined, false, false],
    ['stopped', 'worktree-missing', true, false, false],
    ['stopped', 'start-failed', true, false, false],
    ['working', 'agent-exited', true, false, false],
    ['idle', undefined, true, false, false],
    ['needs-you', undefined, true, false, false],
    ['stopped', 'agent-exited', false, true, false],
    ['stopped', 'not-started', true, true, false],
  ])('canResumeSession(%s, %s, %s, archived=%s) -> %s', (status, stopReason, terminatedUnexpectedly, archived, expected) => {
    expect(canResumeSession(status, stopReason, terminatedUnexpectedly, archived)).toBe(expected);
  });
});

function makeResumeResult(status: SessionStatus, stopReason: SessionRuntimeView['stopReason'], terminatedUnexpectedly?: boolean): Result<SessionSnapshot> {
  return { ok: true, value: { runtime: { status, stopReason, terminatedUnexpectedly } } as unknown as SessionSnapshot };
}

describe('stillEligibleAfterResume', () => {
  // prompt-failed means agent.start() already succeeded; every other hard failure never started anything.
  it('reports NOT eligible for prompt-failed, but eligible for every other hard failure, regardless of archived', () => {
    const promptFailed: Result<SessionSnapshot> = { ok: false, error: { code: 'prompt-failed', message: 'network blip' } };
    expect(stillEligibleAfterResume(promptFailed, false)).toBe(false);
    expect(stillEligibleAfterResume(promptFailed, true)).toBe(false);

    const otherHardFailure: Result<SessionSnapshot> = { ok: false, error: { code: 'invalid-argument', message: 'Session is not eligible to resume.' } };
    expect(stillEligibleAfterResume(otherHardFailure, false)).toBe(true);
    expect(stillEligibleAfterResume(otherHardFailure, true)).toBe(true);
  });

  it('reports NOT eligible (keep the pending flag) for a restart failure, so focus still moves to the open button', () => {
    const result = makeResumeResult('stopped', 'start-failed', true);
    expect(stillEligibleAfterResume(result, false)).toBe(false);
  });

  // The enclosing call site (SessionList.tsx's handleResume) only ever reaches this function for a
  // hard failure or a restart failure (status still 'stopped') -- a genuine success (status flips
  // to 'idle'/'running') never calls it at all, since that branch's own `restartFailed` check is
  // false.
  it("reports NOT eligible for a non-stopped status (never actually reached at the real call site)", () => {
    const result = makeResumeResult('idle', undefined, undefined);
    expect(stillEligibleAfterResume(result, false)).toBe(false);
  });

  it('delegates to canResumeSession rather than duplicating the rule, for every ok:true case', () => {
    const result = makeResumeResult('stopped', 'agent-exited', false);
    expect(stillEligibleAfterResume(result, false)).toBe(canResumeSession('stopped', 'agent-exited', false, false));
    expect(stillEligibleAfterResume(result, true)).toBe(canResumeSession('stopped', 'agent-exited', false, true));
  });
});
