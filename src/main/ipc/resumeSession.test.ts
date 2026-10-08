// Issue #509 quality-gate fix (cycle 2, 2026-10-08): regression coverage for resumeSessionCore
// against injected fakes -- `resumeEligibility.test.ts` only ever proved the pure
// `checkResumeEligible` function works, never that the HANDLER actually adds to the lock before
// any await, releases it on every exit path, or sends the instruction exactly once under real
// concurrency.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { resumeSessionCore } from './resumeSession';
import type { ResumableAgent, ResumeSessionDeps } from './resumeSession';
import type { Session } from '../../shared/model';
import type { SessionSnapshot } from '../../shared/ipc';

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

function makeSnapshot(status: 'idle' | 'stopped'): SessionSnapshot {
  return {
    runtime: {
      sessionId: 'session-1',
      status,
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

/** `start()` resolves after a real (short) delay, flipping `status` to `idle` -- enough for two
 * calls started back to back (no await between them) to genuinely overlap while both are
 * in-flight, the same race a real `agent.start()` spawning a real process creates, without this
 * test file hand-wiring its own promise-release gating. */
function makeAgent(initialStatus: 'stopped' | 'idle' = 'stopped', startDelayMs = 10) {
  const runtimeSnapshot = { status: initialStatus as 'stopped' | 'idle', stopReason: 'agent-exited' as const, stoppedOnRequest: false };
  const send = vi.fn(async () => ({ queued: false }));
  const start = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, startDelayMs));
    runtimeSnapshot.status = 'idle';
  });
  return { agent: { runtimeSnapshot, start, send } as unknown as ResumableAgent, send, start };
}

function makeDeps(overrides: Partial<ResumeSessionDeps> = {}): ResumeSessionDeps {
  const session = makeSession();
  return {
    getSession: () => session,
    getOrCreateAgent: () => makeAgent().agent,
    notifyListChanged: () => {},
    detectUnexpectedTermination: async () => ({ terminatedUnexpectedly: false, reason: { kind: 'clean' as const }, pendingToolNames: [] }),
    buildSnapshot: async (agent) => makeSnapshot(agent.runtimeSnapshot.status === 'stopped' ? 'stopped' : 'idle'),
    ...overrides,
  };
}

describe('resumeSessionCore', () => {
  it('refuses a concurrent second call for the same id while the first is still in flight', async () => {
    const resumingIds = new Set<string>();
    const { agent, send } = makeAgent();
    const deps = makeDeps({ getOrCreateAgent: () => agent });

    const first = resumeSessionCore(resumingIds, 'session-1', deps);
    // Let the microtask queue run so the lock-check-then-add (no await between them) has
    // definitely happened before the second call starts.
    await Promise.resolve();
    const second = await resumeSessionCore(resumingIds, 'session-1', deps);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('invalid-argument');

    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the instruction exactly once under real concurrency (two calls started before either resolves)', async () => {
    const resumingIds = new Set<string>();
    const { agent, send } = makeAgent();
    const deps = makeDeps({ getOrCreateAgent: () => agent });

    const first = resumeSessionCore(resumingIds, 'session-1', deps);
    const second = resumeSessionCore(resumingIds, 'session-1', deps);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const results = [firstResult, secondResult];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('releases the lock after agent.start() resolves but the resulting snapshot is still stopped', async () => {
    const agent = {
      runtimeSnapshot: { status: 'stopped', stopReason: 'agent-exited', stoppedOnRequest: false },
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ queued: false })),
    } as unknown as ResumableAgent;
    const resumingIds = new Set<string>();
    const deps = makeDeps({ getOrCreateAgent: () => agent, buildSnapshot: async () => makeSnapshot('stopped') });

    const result = await resumeSessionCore(resumingIds, 'session-1', deps);
    expect(result.ok).toBe(true);
    expect((agent.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(resumingIds.has('session-1')).toBe(false);

    // A later call for the same id must not be refused as "already in progress".
    const second = await resumeSessionCore(resumingIds, 'session-1', deps);
    expect(second.ok).toBe(true);
  });

  it('releases the lock after a failed send, reporting prompt-failed', async () => {
    const resumingIds = new Set<string>();
    const { agent, send } = makeAgent(undefined, 0);
    send.mockRejectedValueOnce(new Error('network blip'));
    const deps = makeDeps({ getOrCreateAgent: () => agent });

    const result = await resumeSessionCore(resumingIds, 'session-1', deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('prompt-failed');
      expect(result.error.message).toBe('network blip');
    }
    expect(resumingIds.has('session-1')).toBe(false);
  });

  it('refuses a third call after completion as not-stopped (the agent is now idle)', async () => {
    const resumingIds = new Set<string>();
    const { agent } = makeAgent(undefined, 0);
    const deps = makeDeps({ getOrCreateAgent: () => agent });

    const first = await resumeSessionCore(resumingIds, 'session-1', deps);
    expect(first.ok).toBe(true);

    const third = await resumeSessionCore(resumingIds, 'session-1', deps);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.message).toBe('Session is not stopped.');
  });

  it('skips the tail read and refuses as not-eligible for a requested stop (stoppedOnRequest)', async () => {
    const resumingIds = new Set<string>();
    const agent = {
      runtimeSnapshot: { status: 'stopped', stopReason: 'not-started', stoppedOnRequest: true },
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ queued: false })),
    } as unknown as ResumableAgent;
    const detectUnexpectedTermination = vi.fn(async () => ({ terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' as const }, pendingToolNames: ['bash'] }));
    const deps = makeDeps({ getOrCreateAgent: () => agent, detectUnexpectedTermination });

    const result = await resumeSessionCore(resumingIds, 'session-1', deps);
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Session is not eligible to resume.');
  });

  it('returns not-found for an unknown session id', async () => {
    const resumingIds = new Set<string>();
    const deps = makeDeps({ getSession: () => undefined });
    const result = await resumeSessionCore(resumingIds, 'missing', deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  // Quality-gate fix (cycle 3, 2026-10-08, test-reviewer, Medium): `agent.start()`'s own
  // `.catch(() => undefined)` was never proven to actually swallow a rejection rather than merely
  // happening to work when `start()` resolves cleanly in every other test above.
  it('swallows a rejected agent.start() and still returns the (still-stopped) resulting snapshot', async () => {
    const resumingIds = new Set<string>();
    const agent = {
      runtimeSnapshot: { status: 'stopped', stopReason: 'agent-exited', stoppedOnRequest: false },
      start: vi.fn(async () => { throw new Error('spawn ENOENT'); }),
      send: vi.fn(async () => ({ queued: false })),
    } as unknown as ResumableAgent;
    const deps = makeDeps({ getOrCreateAgent: () => agent, buildSnapshot: async () => makeSnapshot('stopped') });

    const result = await resumeSessionCore(resumingIds, 'session-1', deps);

    expect(result.ok).toBe(true);
    expect((agent.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(resumingIds.has('session-1')).toBe(false);
  });

  // Quality-gate fix (cycle 3, 2026-10-08, test-reviewer, Medium): unlike `agent.start()` and
  // `agent.send()`, nothing here catches a thrown `buildSnapshot` -- proves the lock is still
  // released (the `finally`), and that this propagates as a rejection rather than being silently
  // swallowed, same as every other `buildSnapshot` caller in this codebase (for example
  // `conversations.ts`'s own unguarded `await buildSnapshot(...)` calls).
  it('propagates a thrown buildSnapshot as a rejection, still releasing the lock', async () => {
    const resumingIds = new Set<string>();
    const { agent } = makeAgent(undefined, 0);
    const deps = makeDeps({ getOrCreateAgent: () => agent, buildSnapshot: async () => { throw new Error('ENOENT: no such file'); } });

    await expect(resumeSessionCore(resumingIds, 'session-1', deps)).rejects.toThrow('ENOENT: no such file');
    expect(resumingIds.has('session-1')).toBe(false);
  });
});

// Quality-gate fix (cycle 4, 2026-10-08): `agent.runtimeSnapshot.stoppedOnRequest` is reset
// `false` for a Session not yet started THIS run (a fresh in-memory agent after an app restart)
// -- the persisted marker must still be consulted so a Resume is correctly refused for a
// deliberate stop, exactly as if the in-memory flag itself were true.
describe('resumeSessionCore persisted stoppedOnRequest marker', () => {
  it('refuses as not-eligible via the persisted marker alone, with the in-memory flag false', async () => {
    const resumingIds = new Set<string>();
    const conversation = path.join(os.tmpdir(), `refract-resume-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size } = await fs.stat(conversation);
    const agent = {
      runtimeSnapshot: { status: 'stopped', stopReason: 'not-started', stoppedOnRequest: false },
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ queued: false })),
    } as unknown as ResumableAgent;
    const detectUnexpectedTermination = vi.fn(async () => ({ terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' as const }, pendingToolNames: ['bash'] }));
    const deps = makeDeps({
      getSession: () => makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size }),
      getOrCreateAgent: () => agent,
      detectUnexpectedTermination,
    });

    const result = await resumeSessionCore(resumingIds, 'session-1', deps);

    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Session is not eligible to resume.');
  });

  it('ignores the marker once the Conversation has grown, reading the tail and allowing the resume', async () => {
    const resumingIds = new Set<string>();
    const conversation = path.join(os.tmpdir(), `refract-resume-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size: sizeAtStop } = await fs.stat(conversation);
    await fs.appendFile(conversation, '{"type":"assistant"}\n');
    const runtimeSnapshot = { status: 'stopped' as 'stopped' | 'idle', stopReason: 'not-started' as const, stoppedOnRequest: false };
    const send = vi.fn(async () => ({ queued: false }));
    const agent = {
      runtimeSnapshot,
      start: vi.fn(async () => {
        runtimeSnapshot.status = 'idle';
      }),
      send,
    } as unknown as ResumableAgent;
    const detectUnexpectedTermination = vi.fn(async () => ({ terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' as const }, pendingToolNames: ['bash'] }));
    const deps = makeDeps({
      getSession: () => makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: sizeAtStop }),
      getOrCreateAgent: () => agent,
      detectUnexpectedTermination,
    });

    const result = await resumeSessionCore(resumingIds, 'session-1', deps);

    expect(detectUnexpectedTermination).toHaveBeenCalledWith(conversation);
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
