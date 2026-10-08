// Issue #509 quality-gate fix: canAutoStart used to be an un-exported, untested inline function.
import { describe, it, expect } from 'vitest';
import { canAutoStart } from './canAutoStart';
import type { SessionRuntimeView } from '../../shared/ipc';

describe('canAutoStart', () => {
  it.each<[SessionRuntimeView['stopReason'], boolean, boolean]>([
    [undefined, false, true],
    [undefined, true, false],
    ['not-started', false, true],
    ['not-started', true, false],
    ['worktree-missing', false, true],
    ['worktree-missing', true, true],
    ['agent-exited', false, false],
    ['agent-exited', true, false],
    ['start-failed', false, false],
    ['start-failed', true, false],
  ])('canAutoStart(%s, terminatedUnexpectedly=%s) -> %s', (stopReason, terminatedUnexpectedly, expected) => {
    expect(canAutoStart(stopReason, terminatedUnexpectedly)).toBe(expected);
  });
});
