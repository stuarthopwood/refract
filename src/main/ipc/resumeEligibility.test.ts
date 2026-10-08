// Issue #509 quality-gate fix: regression coverage for the two things `sessions.resume` must
// never get wrong -- a concurrent second call for the same Session id refused, and eligibility
// re-checked server-side rather than trusted from the renderer's own (possibly stale) state.
import { describe, it, expect } from 'vitest';
import { checkResumeEligible } from './resumeEligibility';

describe('checkResumeEligible', () => {
  it('refuses a concurrent second call for the same id', () => {
    const resumingIds = new Set(['session-1']);
    expect(checkResumeEligible(resumingIds, 'session-1', 'stopped', 'agent-exited', false)).toBe('already-resuming');
  });

  it('allows a concurrent call for a different id', () => {
    const resumingIds = new Set(['session-1']);
    expect(checkResumeEligible(resumingIds, 'session-2', 'stopped', 'agent-exited', false)).toBeNull();
  });

  it('refuses once the Session is no longer stopped (a prior call already restarted it)', () => {
    const resumingIds = new Set<string>();
    expect(checkResumeEligible(resumingIds, 'session-1', 'working', 'agent-exited', false)).toBe('not-stopped');
  });

  it('re-checks eligibility server-side instead of trusting the caller', () => {
    const resumingIds = new Set<string>();
    expect(checkResumeEligible(resumingIds, 'session-1', 'stopped', 'worktree-missing', true)).toBe('not-eligible');
    expect(checkResumeEligible(resumingIds, 'session-1', 'stopped', 'start-failed', true)).toBe('not-eligible');
    expect(checkResumeEligible(resumingIds, 'session-1', 'stopped', 'not-started', false)).toBe('not-eligible');
  });

  it('allows the normal resume case', () => {
    const resumingIds = new Set<string>();
    expect(checkResumeEligible(resumingIds, 'session-1', 'stopped', 'agent-exited', false)).toBeNull();
    expect(checkResumeEligible(resumingIds, 'session-1', 'stopped', 'not-started', true)).toBeNull();
  });
});
