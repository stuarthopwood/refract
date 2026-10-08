// Issue #510 slice 1 (PLAN.md row A0): regression coverage for tail-parsing edge cases --
// empty file, a partial/truncated last line, `session_exit` present/absent, and unmatched tool
// starts -- plus proof the tail window genuinely never reads earlier file content.
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

async function writeScratch(content: string): Promise<string> {
  const file = path.join(os.tmpdir(), `termination-detection-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
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

const sessionExit = (reason: string) => line({ type: 'session_exit', reason });

const abortedAssistant = () =>
  line({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' } });

describe('detectUnexpectedTermination', () => {
  it('reports clean for a null file (no Conversation yet), no file access attempted', async () => {
    const result = await detectUnexpectedTermination(null);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
  });

  it('reports clean for a missing file', async () => {
    const result = await detectUnexpectedTermination(path.join(os.tmpdir(), 'termination-detection-test-does-not-exist.jsonl'));
    expect(result.terminatedUnexpectedly).toBe(false);
  });

  it('reports clean for an empty file', async () => {
    const file = await writeScratch('');
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
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
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
  });

  it('a session_exit record with reason "sighup" is unexpected', async () => {
    const file = await writeScratch(userMessage() + assistantToolCall('call-1', 'bash') + toolResult('call-1') + sessionExit('sighup'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'exit-record', reason: 'sighup' });
  });

  it('no exit record, every tool call matched: clean', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'bash') + toolResult('call-1'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
  });

  it('no exit record, an unmatched tool call: unexpected, names the pending tool', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'eval') + assistantToolCall('call-2', 'ask'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'unmatched-tool' });
    expect(result.pendingToolNames.sort()).toEqual(['ask', 'eval']);
  });

  it('a later tool result clears an earlier pending call, leaving only the still-unmatched one', async () => {
    const file = await writeScratch(assistantToolCall('call-1', 'eval') + assistantToolCall('call-2', 'wait') + toolResult('call-1'));
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.pendingToolNames).toEqual(['wait']);
  });

  it('a trailing aborted assistant message (no tool call) is unexpected', async () => {
    const file = await writeScratch(userMessage() + abortedAssistant());
    const result = await detectUnexpectedTermination(file);
    expect(result.terminatedUnexpectedly).toBe(true);
    expect(result.reason).toEqual({ kind: 'aborted-message' });
  });

  it('an aborted marker followed by a later user turn is no longer the trailing entry: clean', async () => {
    const file = await writeScratch(abortedAssistant() + userMessage());
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
  });

  it('only reads the tail: a clean session_exit inside the window overrides an unexpected one written earlier, outside it', async () => {
    // Padding comfortably exceeds the 256 KiB tail window, so the leading 'sighup' record sits
    // well before where the window starts; only the trailing 'dispose' record is ever seen.
    const padding = 'x'.repeat(2048);
    const paddingLines = Array.from({ length: 200 }, () => line({ type: 'notice', padding })).join('');
    const file = await writeScratch(sessionExit('sighup') + paddingLines + assistantToolCall('call-1', 'bash') + toolResult('call-1') + sessionExit('dispose'));
    const result = await detectUnexpectedTermination(file);
    expect(result).toEqual({ terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] });
  });
});
