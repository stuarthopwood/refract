// Issue #509 quality-gate fix (cycle 3, 2026-10-08): regression coverage for `resumeSession` --
// the renderer-side glue that decides which `applySnapshot*` variant to use. `environment:
// 'node'` has no real `window`, so a minimal `window.refract.sessions.resume` stub is installed
// directly on `globalThis` before each call (same technique as `sessions-store.test.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resumeSession } from './resume';
import { applySnapshot, applySnapshotExceptTranscript } from './applySnapshot';

vi.mock('./applySnapshot', () => ({
  applySnapshot: vi.fn(),
  applySnapshotExceptTranscript: vi.fn(),
}));

function makeSnapshot(status: 'idle' | 'stopped') {
  return { runtime: { status }, conversations: [], readout: {}, subagents: [] };
}

describe('resumeSession', () => {
  beforeEach(() => {
    vi.mocked(applySnapshot).mockClear();
    vi.mocked(applySnapshotExceptTranscript).mockClear();
  });

  // Quality-gate fix (cycle 2, 2026-10-08) regression: a `stopped` snapshot means the restart
  // itself failed and no instruction was ever sent -- this snapshot IS the full current state, so
  // the transcript must be applied too, not skipped.
  it('applies the full snapshot (including transcript) when the restart itself failed', async () => {
    const snapshot = makeSnapshot('stopped');
    (globalThis as unknown as { window: unknown }).window = {
      refract: { sessions: { resume: vi.fn(async () => ({ ok: true, value: snapshot })) } },
    };

    const result = await resumeSession('session-1');

    expect(result).toEqual({ ok: true, value: snapshot });
    expect(applySnapshot).toHaveBeenCalledWith('session-1', snapshot);
    expect(applySnapshotExceptTranscript).not.toHaveBeenCalled();
  });

  // The instruction WAS already sent as part of the same main-process call, after this snapshot
  // was built -- applying its transcript here would flash back over whatever the send's own live
  // `transcript:patch` events already streamed in while this IPC round trip was still in flight.
  it('applies the snapshot EXCEPT its transcript when the agent actually resumed', async () => {
    const snapshot = makeSnapshot('idle');
    (globalThis as unknown as { window: unknown }).window = {
      refract: { sessions: { resume: vi.fn(async () => ({ ok: true, value: snapshot })) } },
    };

    const result = await resumeSession('session-1');

    expect(result).toEqual({ ok: true, value: snapshot });
    expect(applySnapshotExceptTranscript).toHaveBeenCalledWith('session-1', snapshot);
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('applies nothing and passes the error through on failure', async () => {
    const error = { code: 'invalid-argument' as const, message: 'A resume for this Session is already in progress.' };
    (globalThis as unknown as { window: unknown }).window = {
      refract: { sessions: { resume: vi.fn(async () => ({ ok: false, error })) } },
    };

    const result = await resumeSession('session-1');

    expect(result).toEqual({ ok: false, error });
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(applySnapshotExceptTranscript).not.toHaveBeenCalled();
  });
});
