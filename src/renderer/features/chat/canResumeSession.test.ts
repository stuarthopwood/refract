// Issue #509 (PLAN.md row A2g) requirement 1: regression coverage for when the Resume button
// shows and when it must not.
import { describe, it, expect } from 'vitest';
import { canResumeSession } from './canResumeSession';

describe('canResumeSession', () => {
  it('shows for a live agent-exited Session', () => {
    expect(canResumeSession('stopped', 'agent-exited', false)).toBe(true);
  });

  it('shows for a cold not-started Session whose Conversation tail is terminatedUnexpectedly', () => {
    expect(canResumeSession('stopped', 'not-started', true)).toBe(true);
  });

  it('shows for an undefined stopReason with terminatedUnexpectedly (never-launched-this-run row)', () => {
    expect(canResumeSession('stopped', undefined, true)).toBe(true);
  });

  it('does not show for a normal not-started Session with no termination evidence', () => {
    expect(canResumeSession('stopped', 'not-started', false)).toBe(false);
  });

  it('does not show for worktree-missing even if somehow flagged terminatedUnexpectedly', () => {
    expect(canResumeSession('stopped', 'worktree-missing', true)).toBe(false);
  });

  it('does not show for start-failed even if somehow flagged terminatedUnexpectedly (until #449 is fully landed)', () => {
    expect(canResumeSession('stopped', 'start-failed', true)).toBe(false);
  });

  it('does not show for any live, non-stopped status', () => {
    expect(canResumeSession('working', 'agent-exited', true)).toBe(false);
    expect(canResumeSession('idle', undefined, true)).toBe(false);
    expect(canResumeSession('needs-you', undefined, true)).toBe(false);
  });
});
