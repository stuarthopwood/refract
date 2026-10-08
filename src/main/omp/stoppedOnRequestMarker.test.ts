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
import { describe, it, expect, vi } from 'vitest';
import { RegistryStore } from '../store/registry';
import type { Session } from '../../shared/model';
import {
  clearStoppedOnRequestMarker,
  isStoppedOnRequestMarkerValid,
  recordStoppedOnRequestMarker,
  resolveTermination,
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

  // Quality-gate fix (cycle 5, 2026-10-08): closes the race with `launch()`'s `clear` -- a new
  // life starting while this call's own `fs.stat` is still in flight must stop this call from
  // re-arming the marker for that new life once the stat resolves.
  it('skips the write entirely when stillCurrent() reports false after the stat resolves', async () => {
    const { dir, registry } = await freshRegistry();
    const conversation = await freshConversation();
    const session = makeSession({ currentConversation: conversation });
    await registry.addSession(session);

    await recordStoppedOnRequestMarker(registry, session.id, conversation, () => false);

    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
    const reopened = await RegistryStore.open(dir);
    expect(reopened.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
  });

  it('still writes when stillCurrent() reports true (the default for every real caller today)', async () => {
    const { registry } = await freshRegistry();
    const conversation = await freshConversation();
    const session = makeSession({ currentConversation: conversation });
    await registry.addSession(session);

    await recordStoppedOnRequestMarker(registry, session.id, conversation, () => true);

    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBe(conversation);
  });

  // Quality-gate fix (cycle 6, 2026-10-08, test-reviewer, Medium): the two tests above only ever
  // pass a STATIC `stillCurrent` (always `true` or always `false`), which would pass identically
  // whether the real implementation checks it before OR after the `fs.stat` await -- neither
  // proves the ordering the fix actually depends on (`SessionAgent.onExit`'s own `lifeEpoch`
  // comparison is only ever accurate once read AFTER the stat has had a chance to lose a race to
  // a concurrent `launch()`). This flips the flag in the SAME synchronous tick as the call,
  // before the real `fs.stat`'s own promise can possibly have settled -- a check performed
  // before the stat would still observe `true` (the call's own synchronous portion runs before
  // this test's very next line), while the correct after-the-stat check observes `false`.
  it('checks stillCurrent() AFTER the stat, not before -- a flag flipped during the stat still blocks the write', async () => {
    const { dir, registry } = await freshRegistry();
    const conversation = await freshConversation();
    const session = makeSession({ currentConversation: conversation });
    await registry.addSession(session);

    let current = true;
    const pending = recordStoppedOnRequestMarker(registry, session.id, conversation, () => current);
    current = false;
    await pending;

    expect(registry.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
    const reopened = await RegistryStore.open(dir);
    expect(reopened.getSession(session.id)?.stoppedOnRequestConversation).toBeUndefined();
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

// Quality-gate fix (cycle 5, 2026-10-08, DRY): the shared "requested stop (flag or marker) ->
// clean, else read the tail" rule every call site now routes through.
describe('resolveTermination', () => {
  it('returns clean without calling detect when stoppedOnRequest is true', async () => {
    const detect = vi.fn(async () => ({ terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' as const }, pendingToolNames: ['bash'] }));
    const session = makeSession({ currentConversation: 'C:/x.jsonl' });
    const result = await resolveTermination(session, true, detect);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
    expect(detect).not.toHaveBeenCalled();
  });

  it('returns clean without calling detect when the persisted marker is valid', async () => {
    const conversation = await freshConversation();
    const { size } = await fs.stat(conversation);
    const detect = vi.fn(async () => ({ terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' as const }, pendingToolNames: ['bash'] }));
    const session = makeSession({ currentConversation: conversation, stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size });
    const result = await resolveTermination(session, false, detect);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
    expect(detect).not.toHaveBeenCalled();
  });

  it('calls the injected detect (not the real module) when neither the flag nor the marker apply', async () => {
    const conversation = await freshConversation();
    const CRASHED = { terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' as const }, pendingToolNames: ['bash'] };
    const detect = vi.fn(async () => CRASHED);
    const session = makeSession({ currentConversation: conversation });
    const result = await resolveTermination(session, false, detect);
    expect(result).toBe(CRASHED);
    expect(detect).toHaveBeenCalledWith(conversation);
  });
});
