// Issue #509 (PLAN.md row A2g) requirement 1: regression coverage for when the Resume button
// shows (and server-side, when `sessions.resume` allows it) and when it must not.
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
    // Quality-gate fix (cycle 5, 2026-10-08): an archived Session must never show Resume, even
    // when every other condition is otherwise eligible (an agent that crashed this run, then was
    // archived, keeps stopReason:'agent-exited' -- archive() does not touch a dead agent).
    ['stopped', 'agent-exited', false, true, false],
    ['stopped', 'not-started', true, true, false],
  ])('canResumeSession(%s, %s, %s, archived=%s) -> %s', (status, stopReason, terminatedUnexpectedly, archived, expected) => {
    expect(canResumeSession(status, stopReason, terminatedUnexpectedly, archived)).toBe(expected);
  });
});

function makeResumeResult(status: SessionStatus, stopReason: SessionRuntimeView['stopReason'], terminatedUnexpectedly?: boolean): Result<SessionSnapshot> {
  return { ok: true, value: { runtime: { status, stopReason, terminatedUnexpectedly } } as unknown as SessionSnapshot };
}

// Issue #509 quality-gate fix (cycle 7, 2026-10-08, a11y-auditor, Medium): the Resume row's own
// pending-focus flag must only be cleared when the Session is still resumable after the call --
// otherwise a restart failure (ok:true, still stopped) leaves focus stranded on `<body>` instead
// of moving it to the open button once the Resume button disappears.
describe('stillEligibleAfterResume', () => {
  // Issue #603 quality-gate follow-up (Medium, accessibility): flips this test's own old
  // pinned rule -- prompt-failed means agent.start() already succeeded and only the turn send
  // afterwards threw, so the Session already left 'stopped' and is no longer eligible, the
  // same as a genuine success; must NOT clear the pending flag for THIS code. Every other hard
  // failure never started anything, so the Session's own resumability is unchanged.
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

  // The enclosing call site (SessionList.tsx's handleResume) only ever reaches this function
  // for a hard failure or a restart failure (status still 'stopped') -- a genuine success
  // (status flips to 'idle'/'running') never calls it at all, since that branch's own
  // `restartFailed` check is false. Documented here for completeness: with a non-stopped
  // status, `canResumeSession` (and so this function) is unconditionally false regardless of
  // every other field, matching its own status !== 'stopped' guard.
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
