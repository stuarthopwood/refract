// Issue #510 quality-gate fix (cycle 3, 2026-10-08): regression coverage for the exact race that
// let a crash's generic "agent-exited" verdict overwrite a more specific, already-recorded
// reason (start-failed with its stderr detail, worktree-missing, not-started).
import { describe, it, expect } from 'vitest';
import { shouldApplyCrashExitVerdict } from './exitVerdictGuard';

describe('shouldApplyCrashExitVerdict', () => {
  it('applies the verdict for an ordinary crash: still live, same life', () => {
    expect(shouldApplyCrashExitVerdict('working', 3, 3)).toBe(true);
    expect(shouldApplyCrashExitVerdict('idle', 3, 3)).toBe(true);
    expect(shouldApplyCrashExitVerdict('needs-you', 3, 3)).toBe(true);
  });

  it('skips the verdict once something else already moved the Session to stopped for the same life', () => {
    // launch()'s own synchronous recordStartFailure (or a requested-stop bail) already ran
    // while this exit's tail read was still in flight.
    expect(shouldApplyCrashExitVerdict('stopped', 3, 3)).toBe(false);
  });

  it('skips the verdict once a NEWER life has started, even if the Session is live again', () => {
    // A fresh launch() began (bumping lifeEpoch) and already reached 'idle' by the time this
    // now-stale exit's tail read resolved.
    expect(shouldApplyCrashExitVerdict('idle', 4, 3)).toBe(false);
  });

  it('skips the verdict once a newer life has started AND is itself now stopped (both guards independently true)', () => {
    expect(shouldApplyCrashExitVerdict('stopped', 4, 3)).toBe(false);
  });
});
