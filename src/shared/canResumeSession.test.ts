// Issue #509 (PLAN.md row A2g) requirement 1: regression coverage for when the Resume button
// shows (and server-side, when `sessions.resume` allows it) and when it must not.
import { describe, it, expect } from 'vitest';
import { canResumeSession } from './canResumeSession';
import type { SessionStatus } from './model';
import type { SessionRuntimeView } from './ipc';

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
