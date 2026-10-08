// Issue #510 slice 5 (PLAN.md row A0): regression coverage for re-baselining `lastMessageCount`
// after a drop -- the exact mechanism #449 built (Constitution v1.9.0, docs/spike/FINDINGS.md
// item 44) and slice 5 names as the thing #510's own long-running Sessions need too, since OMP
// compaction (`/shake`, auto-compaction) is one more real-world cause of a lower reattach
// `messageCount`, alongside the aborted-assistant-turn drop item 44 originally reproduced. No
// test existed for this module before now (it predates vitest's introduction in this story).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertConversationFileExists, reattachRebaselineNotice, verifyReattach } from './reattachVerification';
import type { Session } from '../../shared/model';
import type { GetStateResponseData } from '../../shared/frames';

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
    lastMessageCount: 446,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<GetStateResponseData> = {}): GetStateResponseData {
  return {
    sessionFile: 'C:/sessions/swift-otter/conv.jsonl',
    sessionId: 'omp-session-1',
    messageCount: 446,
    isSettled: true,
    ...overrides,
  };
}

describe('verifyReattach', () => {
  it('passes a matching file with a positive message count', () => {
    expect(verifyReattach(makeSession(), makeState())).toBeUndefined();
  });

  it('passes even when messageCount dropped below lastMessageCount (compaction, slice 5)', () => {
    const session = makeSession({ lastMessageCount: 446 });
    const state = makeState({ messageCount: 300 }); // e.g. OMP auto-compaction squashed history
    expect(verifyReattach(session, state)).toBeUndefined();
  });

  it('fails on a sessionFile mismatch', () => {
    const session = makeSession({ currentConversation: 'C:/sessions/swift-otter/conv.jsonl' });
    const state = makeState({ sessionFile: 'C:/sessions/swift-otter/different.jsonl' });
    expect(verifyReattach(session, state)).toMatch(/sessionFile mismatch/);
  });

  it('fails on a zero message count', () => {
    expect(verifyReattach(makeSession(), makeState({ messageCount: 0 }))).toMatch(/messageCount is 0/);
  });
});

describe('reattachRebaselineNotice', () => {
  it('is silent when lastMessageCount is null (never attached before)', () => {
    const session = makeSession({ lastMessageCount: null });
    expect(reattachRebaselineNotice(session, makeState({ messageCount: 10 }))).toBeUndefined();
  });

  it('is silent when the count did not drop', () => {
    const session = makeSession({ lastMessageCount: 446 });
    expect(reattachRebaselineNotice(session, makeState({ messageCount: 446 }))).toBeUndefined();
    expect(reattachRebaselineNotice(session, makeState({ messageCount: 500 }))).toBeUndefined();
  });

  it('names both counts when compaction lowers the observed count (slice 5)', () => {
    const session = makeSession({ lastMessageCount: 446 });
    const notice = reattachRebaselineNotice(session, makeState({ messageCount: 300 }));
    expect(notice).toContain('300 messages');
    expect(notice).toContain('446 last seen');
  });
});

describe('assertConversationFileExists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-reattach-verification-test-'));
  const existingFile = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(existingFile, '{}\n');

  it('resolves for a file that exists', async () => {
    await expect(assertConversationFileExists(existingFile)).resolves.toBeUndefined();
  });

  it('throws naming the path for a missing file', async () => {
    const missing = path.join(dir, 'missing.jsonl');
    await expect(assertConversationFileExists(missing)).rejects.toThrow(missing);
  });
});
