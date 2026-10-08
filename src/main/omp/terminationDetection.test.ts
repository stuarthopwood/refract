// Issue #510 slice 1 (PLAN.md row A0): regression coverage for tail-parsing edge cases --
// empty file, a partial/truncated last line, `session_exit` present/absent, unmatched tool
// starts, judging each process life on its own (quality gate 2026-10-08), and the tail-only
// read guarantee.
//
// Scratch Conversation files are written under the OS temp directory only (never inside this
// repo) and left in place rather than deleted: each run's filename is unique
// (`Date.now()`-and-random, never reused), so leaving them is harmless and avoids this project's
// destructive-delete guard ever needing to trust a non-literal path.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectUnexpectedTermination } from './terminationDetection';

let scratchCounter = 0;

async function writeScratch(content: string): Promise<string> {
  // A per-test unique counter (not just Date.now()) keeps two scratch files written in the same
  // millisecond -- common for the padding-heavy tail-window tests -- from colliding and defeating
  // the detection cache the module keeps keyed by (file path, size, mtimeMs).
  scratchCounter += 1;
  const file = path.join(os.tmpdir(), `termination-detection-test-${Date.now()}-${scratchCounter}-${Math.random().toString(36).slice(2)}.jsonl`);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

const assistantToolCall = (id: string, name: string) =>
  line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: {} }] } });

const toolResult = (toolCallId: string) => line({ type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'bash', content: [] } });

const userMessage = () => line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });

const sessionExit = (reason?: string) => line({ type: 'session_exit', ...(reason === undefined ? {} : { reason }) });

const abortedAssistant = () =>
  line({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' } });

const CLEAN = { terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] };

describe('detectUnexpectedTermination', () => {
  it('reports clean for a null file (no Conversation yet), no file access attempted', async () => {
    const result = await detectUnexpectedTermination(null);
    expect(result).toEqual(CLEAN);
  });

  it('reports clean for a missing file', async () => {
    const result = await detectUnexpectedTermination(path.join(os.tmpdir(), 'termination-detection-test-does-not-exist.jsonl'));
    expect(result).toEqual(CLEAN);
  });

  it('reports clean for an empty file', async () => {
    const file = await writeScratch('');
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('tolerates a truncated last line (write interrupted mid-record) and still uses earlier fully-parsed lines', async () => {
    const file = await writeScratch(userMessage() + assistantToolCall('call-1', 'bash') + '{"type":"session_exit","reason":"sig');
    const result = await detectUnexpectedTermination(file);
    // The truncated session_exit never parses; the earlier unmatched tool call is still seen.
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'unmatched-tool' });
    expect(result.pendingToolNames).toEqual(['bash']);
  });

  it('a session_exit record with reason "dispose" is a clean stop', async () => {
    const file = await writeScratch(userMessage() + assistantToolCall('call-1', 'bash') + toolResult('call-1') + sessionExit('dispose'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('a session_exit record with reason "sighup" is unexpected', async () => {
    const file = await writeScratch(userMessage() + assistantToolCall('call-1', 'bash') + toolResult('call-1') + sessionExit('sighup'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'exit-record', reason: 'sighup' });
  });

  it('a session_exit record with no reason field reads as "unknown", still unexpected', async () => {
    const file = await writeScratch(userMessage() + sessionExit());
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'exit-record', reason: 'unknown' });
  });

  it('a session_exit record carries its own pendingToolCalls, used as-is', async () => {
    const file = await writeScratch(line({ type: 'session_exit', reason: 'sighup', pendingToolCalls: ['ask', 'eval'] }));
    const result = await detectUnexpectedTermination(file);
    expect(result.pendingToolNames).toEqual(['ask', 'eval']);
  });

  it('a non-string entry inside pendingToolCalls is dropped defensively', async () => {
    const file = await writeScratch(line({ type: 'session_exit', reason: 'sighup', pendingToolCalls: ['ask', 42, null] }));
    const result = await detectUnexpectedTermination(file);
    expect(result.pendingToolNames).toEqual(['ask']);
  });

  it('no exit record, every tool call matched: clean', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'bash') + toolResult('call-1'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('no exit record, an unmatched tool call: unexpected, names the pending tool', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'eval') + assistantToolCall('call-2', 'ask'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'unmatched-tool' });
    expect(result.pendingToolNames.slice().sort()).toEqual(['ask', 'eval']);
  });

  it('a later tool result clears an earlier pending call, leaving only the still-unmatched one', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'eval') + assistantToolCall('call-2', 'wait') + toolResult('call-1'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.pendingToolNames).toEqual(['wait']);
  });

  it('a trailing aborted assistant message with no unresolved tool call is clean (not asserted as its own signal)', async () => {
    // Quality-gate fix: `stopReason: 'aborted'` is also what a user-requested Stop writes
    // (SessionAgent.stop()); asserting it alone would flag an ordinary Stop as a crash. Open
    // question #13 (PLAN.md) leaves whether OMP writes a session_exit for that case unconfirmed.
    const file = await writeScratch(userMessage() + abortedAssistant());
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('an aborted assistant message that also left a tool call unresolved is still unexpected (via the unmatched-tool rule)', async () => {
    const file = await writeScratch(line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }], stopReason: 'aborted' } }));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'unmatched-tool' });
  });

  it('a crashed life resumed and settled cleanly: the old sighup exit record is superseded by later activity', async () => {
    const file = await writeScratch(sessionExit('sighup') + userMessage() + assistantToolCall('call-2', 'bash') + toolResult('call-2'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('a crashed life resumed: the earlier unmatched tool call from before the crash is also forgotten, not carried into the new life', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'bash') + sessionExit('sighup') + userMessage());
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('a crashed life resumed and crashed again: only the LATEST exit record counts', async () => {
    const file = await writeScratch(sessionExit('dispose') + userMessage() + assistantToolCall('call-2', 'bash') + sessionExit('sighup'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'exit-record', reason: 'sighup' });
  });

  it('only reads the tail: an unmatched tool call written before the window is never seen', async () => {
    // If the whole file were read (the bug this guards against), `call-0` would still be
    // unmatched and the result would be `unmatched-tool`; reading only the 256 KiB tail must
    // never see it at all.
    const padding = 'x'.repeat(2048);
    const paddingLines = Array.from({ length: 200 }, () => line({ type: 'notice', padding })).join('');
    const file = await writeScratch(assistantToolCall('call-0', 'bash') + paddingLines + assistantToolCall('call-1', 'bash') + toolResult('call-1'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('handles a single line far bigger than the tail window (e.g. a large write tool call) by expanding the window rather than losing it', async () => {
    const hugeArgument = 'y'.repeat(300 * 1024); // bigger than the 256 KiB base window
    const file = await writeScratch(assistantToolCall('call-1', 'write') + line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'write', arguments: { content: hugeArgument } }] } }));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.pendingToolNames.slice().sort()).toEqual(['write', 'write']);
  });

  it('tolerates CRLF line endings', async () => {
    const crlf = (assistantToolCall('call-1', 'bash') + toolResult('call-1')).replace(/\n/g, '\r\n');
    const file = await writeScratch(crlf);
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('handles a window boundary that lands mid multi-byte UTF-8 character without corrupting later lines', async () => {
    // A padding line containing multi-byte characters placed so the computed byte window is
    // likely to start partway through one; since that padding line is always dropped as the
    // window's own (possibly-fragmentary) first line, only the later, real content must survive.
    const padding = 'éèê'.repeat(1024); // accented multi-byte characters
    const paddingLines = Array.from({ length: 150 }, () => line({ type: 'notice', padding })).join('');
    const file = await writeScratch(paddingLines + assistantToolCall('call-1', 'bash') + toolResult('call-1'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  // Quality-gate fix (cycle 2, 2026-10-08): a hard kill (crash, taskkill) writes no `session_exit`
  // at all, so only the 'user' case's own `outstandingToolCalls.clear()` can tell that life's
  // orphaned call apart from a later, healthy one -- without it, `call-1` stayed unmatched
  // forever, even after `call-2` completed cleanly in a resumed life.
  it('judges a hard-killed life (no exit record) on its own once a later user message starts a new one', async () => {
    const file = await writeScratch(
      assistantToolCall('call-1', 'bash') + userMessage() + assistantToolCall('call-2', 'bash') + toolResult('call-2')
    );
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual(CLEAN);
  });

  it('caches by (file, size, mtimeMs): a later append is detected, not served stale', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'bash') + toolResult('call-1'));
    const first = await detectUnexpectedTermination(file);
    expect(first).toEqual(CLEAN);
    await fs.appendFile(file, assistantToolCall('call-2', 'bash'), 'utf8');
    const second = await detectUnexpectedTermination(file);
    expect(second.terminatedUnexpectedly).toBe(true);
    expect(second.pendingToolNames).toEqual(['bash']);
  });

  it('caches by (file, size, mtimeMs): a deleted file reports clean and evicts the entry', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'bash'));
    const first = await detectUnexpectedTermination(file);
    expect(first.terminatedUnexpectedly).toBe(true);
    await fs.unlink(file);
    const second = await detectUnexpectedTermination(file);
    expect(second).toEqual(CLEAN);
  });
});
