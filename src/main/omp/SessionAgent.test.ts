// Issue #510 quality-gate fix (HIGH, cycle 5, 2026-10-08): regression coverage for the
// marker-write-must-be-awaited-before-quit bug -- `onExit`'s requested branch used to fire
// `recordStoppedOnRequestMarker` with `void`, and `shutdown()` never waited for it, so quitting
// Refract while a Session was mid-tool-call could exit before the marker reached disk (exactly
// the restart case cycle 4 was meant to protect). `SessionAgent` has no other test file and no
// dependency-injection seam for a real `OmpProcess`, so this drives the exact PRIVATE `onExit`
// method directly (`as unknown as` cast -- the only seam available) against a REAL RegistryStore,
// the same technique `SessionManager.test.ts` already established for this class's private state.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../../shared/model';
import type { SettingsStore } from '../store/settings';

vi.mock('./stoppedOnRequestMarker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stoppedOnRequestMarker')>();
  return { ...actual, recordStoppedOnRequestMarker: vi.fn(actual.recordStoppedOnRequestMarker) };
});

import { SessionAgent } from './SessionAgent';
import { RegistryStore } from '../store/registry';
import { recordStoppedOnRequestMarker } from './stoppedOnRequestMarker';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    repositoryId: 'repo-1',
    name: 'Test Session',
    branch: 'swift-otter',
    baseBranch: 'main',
    worktreePath: os.tmpdir(),
    sessionDir: 'C:/sessions/swift-otter',
    currentConversation: null,
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

async function makeAgentAndRegistry(session: Session): Promise<{ dir: string; registry: RegistryStore; agent: SessionAgent }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refract-session-agent-test-'));
  const registry = await RegistryStore.open(dir);
  await registry.addRepository({ id: session.repositoryId, path: 'C:/repos/x', name: 'x', defaultBranch: 'main', addedAt: new Date().toISOString() });
  await registry.addSession(session);
  const agent = new SessionAgent({
    sessionId: session.id,
    registry,
    settings: fakeSettings(),
    isVisible: () => false,
    isWindowFocused: () => true,
  });
  return { dir, registry, agent };
}

describe('SessionAgent.shutdown waits for a pending stoppedOnRequest marker write', () => {
  it('does not resolve until the marker write settles, then the marker is on disk', async () => {
    const conversation = path.join(os.tmpdir(), `refract-agent-marker-${randomUUID()}.jsonl`);
    await fs.writeFile(conversation, '{"type":"user"}\n');
    const session = makeSession({ currentConversation: conversation });
    const { dir, registry, agent } = await makeAgentAndRegistry(session);

    // Gates the real `recordStoppedOnRequestMarker` behind a promise this test controls, so the
    // assertion below is a genuine timing proof, not a race that happens to pass because the
    // write is fast on a real filesystem.
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.mocked(recordStoppedOnRequestMarker).mockImplementationOnce(async (...args) => {
      await gate;
      return (await vi.importActual<typeof import('./stoppedOnRequestMarker')>('./stoppedOnRequestMarker')).recordStoppedOnRequestMarker(...args);
    });

    // Simulates a real process's requested exit: `onExit` is private, there is no public seam
    // and no injectable `OmpProcess`, so this calls it directly -- the only way to exercise the
    // exact production code path (`this.markerWrite = recordStoppedOnRequestMarker(...)`) without
    // building a full fake OMP handshake for a single two-line fix.
    (agent as unknown as { process: unknown }).process = { stop: async () => undefined };
    await (agent as unknown as { onExit: (info: { code: number | null; requested: boolean }) => Promise<void> }).onExit({
      code: null,
      requested: true,
    });
    // `onExit` itself never awaits the marker write (fire-and-forget by design -- `shutdown()` is
    // what must wait), so it has already returned with the write still gated.

    let shutdownResolved = false;
    const shutdownPromise = agent.shutdown().then(() => {
      shutdownResolved = true;
    });

    // Lets every microtask that does NOT depend on `gate` settle; `shutdown()` must still be
    // waiting on the marker write at this point.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    releaseWrite();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);

    const expectedSize = (await fs.stat(conversation)).size;
    const reopened = await RegistryStore.open(dir);
    const persisted = reopened.getSession(session.id);
    expect(persisted?.stoppedOnRequestConversation).toBe(conversation);
    expect(persisted?.stoppedOnRequestAtSize).toBe(expectedSize);
  });
});
