// Issue #510 quality-gate fix (cycle 4, 2026-10-08): regression coverage for the persisted
// stoppedOnRequest marker itself (recordStoppedOnRequestMarker/clearStoppedOnRequestMarker/
// isStoppedOnRequestMarkerValid) -- SessionManager.test.ts and util.test.ts already prove the
// CONSULTATION side (summaries()/buildSnapshot honouring or ignoring it); this file proves the
// marker's own read/write/validate behaviour, including round-tripping through a genuinely
// reopened RegistryStore (the same `RegistryStore.open(dir)` a real app restart performs).
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { RegistryStore } from '../store/registry';
import type { Session } from '../../shared/model';
import {
  clearStoppedOnRequestMarker,
  isStoppedOnRequestMarkerValid,
  recordStoppedOnRequestMarker,
} from './stoppedOnRequestMarker';

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

async function freshRegistry(): Promise<{ dir: string; registry: RegistryStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refract-stopped-on-request-marker-test-'));
  const registry = await RegistryStore.open(dir);
  await registry.addRepository({ id: 'repo-1', path: 'C:/repos/x', name: 'x', defaultBranch: 'main', addedAt: new Date().toISOString() });
  return { dir, registry };
}

async function freshConversation(content = '{"type":"user"}\n'): Promise<string> {
  const file = path.join(os.tmpdir(), `refract-marker-fixture-${randomUUID()}.jsonl`);
  await fs.writeFile(file, content);
  return file;
}

describe('recordStoppedOnRequestMarker', () => {
  it('records the Conversation path and its real current size, surviving a registry reopen', async () => {
    const { dir, registry } = await freshRegistry();
    const conversation = await freshConversation('{"type":"user"}\nmore content\n');
    const session = makeSession({ currentConversation: conversation });
    await registry.addSession(session);

    await recordStoppedOnRequestMarker(registry, session.id, conversation);

    const expectedSize = (await fs.stat(conversation)).size;
    // Restart simulation: a brand new RegistryStore instance, re-reading registry.json fresh.
    const reopened = await RegistryStore.open(dir);
    const persisted = reopened.getSession(session.id);
    expect(persisted?.stoppedOnRequestConversation).toBe(conversation);
    expect(persisted?.stoppedOnRequestAtSize).toBe(expectedSize);
  });

  it('records nothing when the Session has no current Conversation', async () => {
    const { registry } = await freshRegistry();
    const session = makeSession({ currentConversation: null });
    await registry.addSession(session);

    await recordStoppedOnRequestMarker(registry, session.id, null);

    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
  });

  it('never throws when the Conversation file does not exist (stat fails)', async () => {
    const { registry } = await freshRegistry();
    const missing = path.join(os.tmpdir(), `refract-marker-missing-${randomUUID()}.jsonl`);
    const session = makeSession({ currentConversation: missing });
    await registry.addSession(session);

    await expect(recordStoppedOnRequestMarker(registry, session.id, missing)).resolves.toBeUndefined();
    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
  });
});

describe('clearStoppedOnRequestMarker', () => {
  it('clears both fields, surviving a registry reopen', async () => {
    const { dir, registry } = await freshRegistry();
    const conversation = await freshConversation();
    const session = makeSession({
      currentConversation: conversation,
      stoppedOnRequestConversation: conversation,
      stoppedOnRequestAtSize: 42,
    });
    await registry.addSession(session);

    await clearStoppedOnRequestMarker(registry, session.id);

    const reopened = await RegistryStore.open(dir);
    const persisted = reopened.getSession(session.id);
    expect(persisted?.stoppedOnRequestConversation).toBeNull();
    expect(persisted?.stoppedOnRequestAtSize).toBeNull();
  });
});

describe('isStoppedOnRequestMarkerValid', () => {
  it('is true when the marker matches the Conversation\'s real current size exactly', async () => {
    const conversation = await freshConversation();
    const { size } = await fs.stat(conversation);
    const session = makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(true);
  });

  it('is false with no marker at all', async () => {
    const conversation = await freshConversation();
    const session = makeSession({ currentConversation: conversation });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(false);
  });

  it('is false with no current Conversation', async () => {
    const session = makeSession({ currentConversation: null, stoppedOnRequestConversation: 'C:/x.jsonl', stoppedOnRequestAtSize: 0 });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(false);
  });

  it('is false when the marker names a different Conversation than the current one', async () => {
    const conversation = await freshConversation();
    const session = makeSession({
      currentConversation: conversation,
      stoppedOnRequestConversation: await freshConversation(),
      stoppedOnRequestAtSize: 0,
    });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(false);
  });

  it('is false once the Conversation has grown past the recorded size', async () => {
    const conversation = await freshConversation('{"type":"user"}\n');
    const { size } = await fs.stat(conversation);
    await fs.appendFile(conversation, '{"type":"assistant"}\n');
    const session = makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(false);
  });

  it('is false for a non-number size (a hand-edited or corrupt registry.json)', async () => {
    const conversation = await freshConversation();
    const session = makeSession({
      currentConversation: conversation,
      stoppedOnRequestConversation: conversation,
      stoppedOnRequestAtSize: 'not-a-number' as unknown as number,
    });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(false);
  });

  it('is false for a negative or non-finite size', async () => {
    const conversation = await freshConversation();
    const negative = makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: -1 });
    expect(await isStoppedOnRequestMarkerValid(negative)).toBe(false);
    const infinite = makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: Infinity });
    expect(await isStoppedOnRequestMarkerValid(infinite)).toBe(false);
  });

  it('is false when the Conversation file no longer exists', async () => {
    const conversation = path.join(os.tmpdir(), `refract-marker-gone-${randomUUID()}.jsonl`);
    const session = makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: 0 });
    expect(await isStoppedOnRequestMarkerValid(session)).toBe(false);
  });
});
