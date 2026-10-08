// Issue #509 (PLAN.md row A2g) requirement 1: regression coverage for when the Resume button
// shows (and server-side, when `sessions.resume` allows it) and when it must not.
import { describe, it, expect } from 'vitest';
import { canResumeSession } from './canResumeSession';
import type { SessionStatus } from './model';
import type { SessionRuntimeView } from './ipc';

describe('canResumeSession', () => {
  it.each<[SessionStatus, SessionRuntimeView['stopReason'], boolean | undefined, boolean]>([
    ['stopped', 'agent-exited', false, true],
    ['stopped', 'agent-exited', undefined, true],
    ['stopped', 'not-started', true, true],
    ['stopped', undefined, true, true],
    ['stopped', 'not-started', false, false],
    ['stopped', 'not-started', undefined, false],
    ['stopped', undefined, undefined, false],
    ['stopped', 'worktree-missing', true, false],
    ['stopped', 'start-failed', true, false],
    ['working', 'agent-exited', true, false],
    ['idle', undefined, true, false],
    ['needs-you', undefined, true, false],
  ])('canResumeSession(%s, %s, %s) -> %s', (status, stopReason, terminatedUnexpectedly, expected) => {
    expect(canResumeSession(status, stopReason, terminatedUnexpectedly)).toBe(expected);
  });
});
