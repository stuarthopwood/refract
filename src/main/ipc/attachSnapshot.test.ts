// Issue #509 quality-gate fix (cycle 3, 2026-10-08): regression coverage for attachSnapshotCore
// against injected fakes -- `canAutoStart.test.ts` only ever proved the pure `canAutoStart`
// function works, never that the HANDLER actually skips the tail read for a requested stop
// (FR-038), threads the one computed `detection` into `buildSnapshot` instead of a second read,
// or genuinely restarts (`forceStart`) regardless of what the tail shows.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { attachSnapshotCore } from './attachSnapshot';
import type { AttachableAgent, AttachSnapshotDeps } from './attachSnapshot';
import type { Session } from '../../shared/model';
import type { SessionSnapshot } from '../../shared/ipc';
import type { TerminationDetectionResult } from '../omp/terminationDetection';

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

function makeSnapshot(): SessionSnapshot {
  return {
    runtime: {
      sessionId: 'session-1',
      status: 'idle',
      launchedMode: 'ask',
      pendingMode: null,
      unread: false,
      transcript: [],
      queue: { followUp: [], steering: [] },
      pending: [],
    },
    conversations: [],
    readout: {
      currentTime: null,
      contextUsage: null,
      subagentCount: 0,
      todoProgress: null,
    },
    subagents: [],
  } as unknown as SessionSnapshot;
}

function makeAgent(overrides: Partial<AttachableAgent['runtimeSnapshot']> = {}) {
  const runtimeSnapshot = { status: 'stopped' as const, stopReason: 'agent-exited' as const, stoppedOnRequest: false, ...overrides };
  const start = vi.fn(async () => undefined);
  return { agent: { runtimeSnapshot, start } as unknown as AttachableAgent, start };
}

const CLEAN: TerminationDetectionResult = { terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] };
const CRASHED: TerminationDetectionResult = { terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' }, pendingToolNames: ['bash'] };

function makeDeps(overrides: Partial<AttachSnapshotDeps> = {}): AttachSnapshotDeps {
  const session = makeSession();
  return {
    getSession: () => session,
    getOrCreateAgent: () => makeAgent().agent,
    notifyListChanged: () => {},
    detectUnexpectedTermination: async () => CLEAN,
    buildSnapshot: async () => makeSnapshot(),
    ...overrides,
  };
}

describe('attachSnapshotCore', () => {
  it('returns not-found for an unknown session id', async () => {
    const deps = makeDeps({ getSession: () => undefined });
    const result = await attachSnapshotCore('missing', false, deps);
    expect(result.ok).toBe(false);
  });

  it('never reads the tail when the agent is not stopped (no detection, no start)', async () => {
    const { agent, start } = makeAgent({ status: 'idle' });
    const detectUnexpectedTermination = vi.fn(async () => CLEAN);
    const buildSnapshot = vi.fn(async () => makeSnapshot());
    const deps = makeDeps({ getOrCreateAgent: () => agent, detectUnexpectedTermination, buildSnapshot });

    await attachSnapshotCore('session-1', false, deps);

    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(buildSnapshot).toHaveBeenCalledWith(agent, expect.anything(), undefined);
  });

  // Quality-gate fix (cycle 2, 2026-10-08) regression: a requested stop must short-circuit the
  // tail read entirely, same `stopReason` and genuinely-crashed case below proves the opposite
  // outcome for an otherwise-identical agent.
  it('FR-038: short-circuits to clean and auto-starts a requested stop without reading the tail', async () => {
    const { agent, start } = makeAgent({ stopReason: 'not-started', stoppedOnRequest: true });
    const detectUnexpectedTermination = vi.fn(async () => CRASHED);
    const buildSnapshot = vi.fn(async () => makeSnapshot());
    const deps = makeDeps({ getOrCreateAgent: () => agent, detectUnexpectedTermination, buildSnapshot });

    await attachSnapshotCore('session-1', false, deps);

    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(buildSnapshot).toHaveBeenCalledWith(agent, expect.anything(), CLEAN);
  });

  it('a genuinely crashed Session with the same stopReason never auto-starts and the detection reaches buildSnapshot', async () => {
    const { agent, start } = makeAgent({ stopReason: 'not-started', stoppedOnRequest: false });
    const detectUnexpectedTermination = vi.fn(async () => CRASHED);
    const buildSnapshot = vi.fn(async () => makeSnapshot());
    const deps = makeDeps({ getOrCreateAgent: () => agent, detectUnexpectedTermination, buildSnapshot });

    await attachSnapshotCore('session-1', false, deps);

    expect(detectUnexpectedTermination).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(buildSnapshot).toHaveBeenCalledWith(agent, expect.anything(), CRASHED);
  });

  it('forceStart restarts a crashed Session regardless of what the tail shows (recover)', async () => {
    const { agent, start } = makeAgent({ stopReason: 'agent-exited', stoppedOnRequest: false });
    const deps = makeDeps({ getOrCreateAgent: () => agent, detectUnexpectedTermination: async () => CRASHED });

    await attachSnapshotCore('session-1', true, deps);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a passive open never auto-starts an agent-exited Session even when the tail is clean', async () => {
    const { agent, start } = makeAgent({ stopReason: 'agent-exited', stoppedOnRequest: false });
    const deps = makeDeps({ getOrCreateAgent: () => agent, detectUnexpectedTermination: async () => CLEAN });

    await attachSnapshotCore('session-1', false, deps);

    expect(start).not.toHaveBeenCalled();
  });

  it('builds the snapshot from the refreshed session (post-start registry state), not the stale pre-start one', async () => {
    const { agent } = makeAgent({ stopReason: 'not-started', stoppedOnRequest: true });
    const staleSession = makeSession();
    const refreshedSession = makeSession({ lastMessageCount: 99 });
    let fetchCount = 0;
    const buildSnapshot = vi.fn(async () => makeSnapshot());
    const deps = makeDeps({
      getSession: () => (fetchCount++ === 0 ? staleSession : refreshedSession),
      getOrCreateAgent: () => agent,
      buildSnapshot,
    });

    await attachSnapshotCore('session-1', false, deps);

    expect(buildSnapshot).toHaveBeenCalledWith(agent, refreshedSession, CLEAN);
  });

  it('notifies listChanged only when the agent actually starts', async () => {
    const notifyListChanged = vi.fn();
    const { agent: idleAgent } = makeAgent({ status: 'idle' });
    await attachSnapshotCore('session-1', false, makeDeps({ getOrCreateAgent: () => idleAgent, notifyListChanged }));
    expect(notifyListChanged).not.toHaveBeenCalled();

    notifyListChanged.mockClear();
    const { agent: startingAgent } = makeAgent({ stopReason: 'not-started', stoppedOnRequest: true });
    await attachSnapshotCore('session-1', false, makeDeps({ getOrCreateAgent: () => startingAgent, notifyListChanged }));
    expect(notifyListChanged).toHaveBeenCalledTimes(1);
  });
});

// Quality-gate fix (cycle 4, 2026-10-08): `agent.runtimeSnapshot.stoppedOnRequest` is reset
// `false` for a Session not yet started THIS run (a fresh in-memory agent after an app restart)
// -- the persisted marker must still be consulted so a passive open auto-starts it, exactly as
// if the in-memory flag itself were true (same outcome as the FR-038 test above, different
// source of truth).
describe('attachSnapshotCore persisted stoppedOnRequest marker', () => {
  it('auto-starts a requested stop via the persisted marker alone, with the in-memory flag false', async () => {
    const conversation = path.join(os.tmpdir(), `refract-attach-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size } = await fs.stat(conversation);
    const { agent, start } = makeAgent({ stopReason: 'not-started', stoppedOnRequest: false });
    const detectUnexpectedTermination = vi.fn(async () => CRASHED);
    const buildSnapshot = vi.fn(async () => makeSnapshot());
    const deps = makeDeps({
      getSession: () => makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size }),
      getOrCreateAgent: () => agent,
      detectUnexpectedTermination,
      buildSnapshot,
    });

    await attachSnapshotCore('session-1', false, deps);

    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(buildSnapshot).toHaveBeenCalledWith(agent, expect.anything(), CLEAN);
  });

  it('ignores the marker once the Conversation has grown, reading the tail and refusing to auto-start', async () => {
    const conversation = path.join(os.tmpdir(), `refract-attach-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size: sizeAtStop } = await fs.stat(conversation);
    await fs.appendFile(conversation, '{"type":"assistant"}\n');
    const { agent, start } = makeAgent({ stopReason: 'not-started', stoppedOnRequest: false });
    const detectUnexpectedTermination = vi.fn(async () => CRASHED);
    const deps = makeDeps({
      getSession: () => makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: sizeAtStop }),
      getOrCreateAgent: () => agent,
      detectUnexpectedTermination,
    });

    await attachSnapshotCore('session-1', false, deps);

    expect(detectUnexpectedTermination).toHaveBeenCalledWith(conversation);
    expect(start).not.toHaveBeenCalled(); // CRASHED -> terminatedUnexpectedly:true -> canAutoStart refuses
  });
});
