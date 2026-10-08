// Issue #510 quality-gate fix (cycle 3, 2026-10-08): regression coverage for buildSnapshot's
// stoppedOnRequest short-circuit (fixed cycle 2, left untested -- the exact defect that failed
// cycle 2 could have come back silently).
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../../shared/model';
import type { SessionAgent } from '../omp/SessionAgent';

vi.mock('../omp/terminationDetection', () => ({
  detectUnexpectedTermination: vi.fn(async () => ({
    terminatedUnexpectedly: true,
    reason: { kind: 'unmatched-tool' },
    pendingToolNames: ['bash'],
  })),
}));
vi.mock('../conversations', () => ({
  listConversations: vi.fn(async () => []),
}));

import { buildSnapshot } from './util';
import { detectUnexpectedTermination } from '../omp/terminationDetection';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    repositoryId: 'repo-1',
    name: 'Test Session',
    branch: 'swift-otter',
    baseBranch: 'main',
    worktreePath: 'C:/worktrees/swift-otter',
    sessionDir: 'C:/sessions/swift-otter',
    currentConversation: 'C:/sessions/swift-otter/conv.jsonl',
    lastMessageCount: 10,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

function makeAgent(overrides: { status: 'stopped' | 'idle'; stoppedOnRequest: boolean }): SessionAgent {
  return {
    runtimeSnapshot: {
      sessionId: 'session-1',
      status: overrides.status,
      stopReason: overrides.status === 'stopped' ? 'agent-exited' : undefined,
      launchedMode: 'ask',
      pendingMode: null,
      unread: false,
      transcript: [],
      queue: { followUp: [], steering: [] },
      pending: [],
      turnStartedAt: null,
      readout: { currentTime: null, contextUsage: null, subagentCount: 0, todoProgress: null },
      subagents: [],
      stoppedOnRequest: overrides.stoppedOnRequest,
    },
  } as unknown as SessionAgent;
}

describe('buildSnapshot stoppedOnRequest short-circuit', () => {
  it('skips the tail read and reports terminatedUnexpectedly:false when stoppedOnRequest is set', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const agent = makeAgent({ status: 'stopped', stoppedOnRequest: true });
    const snapshot = await buildSnapshot(agent, makeSession());
    expect(snapshot.runtime.terminatedUnexpectedly).toBe(false);
    expect(snapshot.runtime.pendingToolNames).toBeUndefined();
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
  });

  it('reads the tail and passes terminatedUnexpectedly/pendingToolNames through when stoppedOnRequest is false', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const agent = makeAgent({ status: 'stopped', stoppedOnRequest: false });
    const session = makeSession();
    const snapshot = await buildSnapshot(agent, session);
    expect(snapshot.runtime.terminatedUnexpectedly).toBe(true);
    expect(snapshot.runtime.pendingToolNames).toEqual(['bash']);
    expect(detectUnexpectedTermination).toHaveBeenCalledWith(session.currentConversation);
  });

  it('never consults stoppedOnRequest or the tail for a live (non-stopped) Session', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const agent = makeAgent({ status: 'idle', stoppedOnRequest: false });
    const snapshot = await buildSnapshot(agent, makeSession());
    expect(snapshot.runtime.terminatedUnexpectedly).toBeUndefined();
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
  });

  it('never leaks stoppedOnRequest itself onto the renderer-facing snapshot', async () => {
    const agent = makeAgent({ status: 'stopped', stoppedOnRequest: true });
    const snapshot = await buildSnapshot(agent, makeSession());
    expect('stoppedOnRequest' in snapshot.runtime).toBe(false);
  });
});
