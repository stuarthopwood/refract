// Issue #510 quality-gate fix (cycle 3, 2026-10-08): regression coverage for summaries()'s
// stoppedOnRequest short-circuit (fixed cycle 2, left untested -- the exact defect that failed
// cycle 2 could have come back silently). Uses a real RegistryStore (mkdtemp scratch dir, same
// established pattern as src/main/store/registry.test.ts) and a fake agent injected directly
// into the private `agents` map, since SessionManager has no public seam for that.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../shared/model';
import type { SessionAgent } from './omp/SessionAgent';
import type { SettingsStore } from './store/settings';

vi.mock('./omp/terminationDetection', () => ({
  detectUnexpectedTermination: vi.fn(async () => ({
    terminatedUnexpectedly: true,
    reason: { kind: 'unmatched-tool' },
    pendingToolNames: ['bash'],
  })),
}));

import { SessionManager } from './SessionManager';
import { RegistryStore } from './store/registry';
import { detectUnexpectedTermination } from './omp/terminationDetection';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
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

function fakeSettings(): SettingsStore {
  return { get: () => ({ approvalMode: 'ask' }) } as unknown as SettingsStore;
}

function injectAgent(manager: SessionManager, sessionId: string, runtimeOverrides: { status: 'stopped' | 'idle'; stoppedOnRequest: boolean }): void {
  const fakeAgent = {
    runtimeSnapshot: {
      status: runtimeOverrides.status,
      stopReason: runtimeOverrides.status === 'stopped' ? 'agent-exited' : undefined,
      unread: false,
      launchedMode: 'ask',
      pendingMode: null,
      stoppedOnRequest: runtimeOverrides.stoppedOnRequest,
    },
  } as unknown as SessionAgent;
  (manager as unknown as { agents: Map<string, SessionAgent> }).agents.set(sessionId, fakeAgent);
}

async function makeManager(session: Session): Promise<SessionManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refract-session-manager-test-'));
  const registry = await RegistryStore.open(dir);
  await registry.addRepository({ id: session.repositoryId, path: 'C:/repos/x', name: 'x', defaultBranch: 'main', addedAt: new Date().toISOString() });
  await registry.addSession(session);
  return new SessionManager(registry, fakeSettings());
}

describe('SessionManager.summaries stoppedOnRequest short-circuit', () => {
  it('skips the tail read and reports terminatedUnexpectedly:false when stoppedOnRequest is set', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const session = makeSession();
    const manager = await makeManager(session);
    injectAgent(manager, session.id, { status: 'stopped', stoppedOnRequest: true });

    const rows = await manager.summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.terminatedUnexpectedly).toBe(false);
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
  });

  it('reads the tail when stoppedOnRequest is false', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const session = makeSession();
    const manager = await makeManager(session);
    injectAgent(manager, session.id, { status: 'stopped', stoppedOnRequest: false });

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBe(true);
    expect(detectUnexpectedTermination).toHaveBeenCalledWith(session.currentConversation);
  });

  it('never consults stoppedOnRequest or the tail for a live (non-stopped) Session', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const session = makeSession();
    const manager = await makeManager(session);
    injectAgent(manager, session.id, { status: 'idle', stoppedOnRequest: false });

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBeUndefined();
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
  });

  it('never reads the tail for an archived Session, even with stoppedOnRequest false', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const session = makeSession({ archivedAt: new Date().toISOString() });
    const manager = await makeManager(session);
    injectAgent(manager, session.id, { status: 'stopped', stoppedOnRequest: false });

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBeUndefined();
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
  });
});

// Quality-gate fix (cycle 4, 2026-10-08): the PERSISTED sibling of the in-memory
// `stoppedOnRequest` flag above -- a restart simulation, since that is exactly the scenario the
// in-memory flag cannot survive. No `injectAgent` call in these: an empty `agents` map is what a
// genuinely fresh `SessionManager` (a real app restart) looks like before anything is opened.
describe('SessionManager.summaries persisted stoppedOnRequest marker', () => {
  it('honours a persisted marker when no SessionAgent exists this run at all (post-restart)', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const conversation = path.join(os.tmpdir(), `refract-marker-test-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size } = await fs.stat(conversation);
    const session = makeSession({ worktreePath: os.tmpdir(), currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size });
    const manager = await makeManager(session);

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBe(false);
    expect(detectUnexpectedTermination).not.toHaveBeenCalled();
  });

  it('ignores the marker once the Conversation has grown since the recorded size (a later life ran)', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const conversation = path.join(os.tmpdir(), `refract-marker-test-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size: sizeAtStop } = await fs.stat(conversation);
    await fs.appendFile(conversation, '{"type":"assistant"}\n'); // a later life appended more
    const session = makeSession({ worktreePath: os.tmpdir(), currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: sizeAtStop });
    const manager = await makeManager(session);

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBe(true); // falls through to the mocked tail read
    expect(detectUnexpectedTermination).toHaveBeenCalledWith(conversation);
  });

  it('ignores a marker recorded for a different Conversation than the Session\'s current one', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const conversation = path.join(os.tmpdir(), `refract-marker-test-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const { size } = await fs.stat(conversation);
    const session = makeSession({
      worktreePath: os.tmpdir(),
      currentConversation: conversation,
      stoppedOnRequestConversation: path.join(os.tmpdir(), 'a-previous-conversation.jsonl'),
      stoppedOnRequestAtSize: size,
    });
    const manager = await makeManager(session);

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBe(true);
    expect(detectUnexpectedTermination).toHaveBeenCalledWith(conversation);
  });

  it('ignores a corrupt marker (non-number size, e.g. from a hand-edited registry.json)', async () => {
    vi.mocked(detectUnexpectedTermination).mockClear();
    const conversation = path.join(os.tmpdir(), `refract-marker-test-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const session = makeSession({
      worktreePath: os.tmpdir(),
      currentConversation: conversation,
      stoppedOnRequestConversation: conversation,
      stoppedOnRequestAtSize: 'not-a-number' as unknown as number,
    });
    const manager = await makeManager(session);

    const rows = await manager.summaries();
    expect(rows[0]?.terminatedUnexpectedly).toBe(true);
    expect(detectUnexpectedTermination).toHaveBeenCalledWith(conversation);
  });
});
