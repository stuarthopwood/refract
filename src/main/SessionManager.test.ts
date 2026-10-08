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
