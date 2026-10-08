// Issue #510 (PLAN.md row A0, slice 1): tells whether the agent process that was writing a
// Conversation `.jsonl` went away unexpectedly, reading only the TAIL of that file -- never the
// whole thing (a real session file in the issue's own forensic read was 48 MB; this must also
// work cold, before any `omp` process has even been spawned this run, so it cannot depend on a
// live RPC or frame).
//
// Signal, checked in this order:
// 1. A trailing `session_exit` record. [INFERENCE: shape `{type:'session_exit', reason,
//    pendingToolCalls?}`, per the issue's own forensic read of a real session file -- the exact
//    field names are an open question (PLAN.md open question #13, "are the `reason` and `kind`
//    values stable across 18.4.x, 18.5.x and 18.6.3" -- not yet probed against a live binary).
//    Every field is read through `in`/`typeof` narrowing, never an assumed-shape cast: an
//    unexpected record is tolerated, same discipline as `transcript.ts`'s `currentTurnKeys`
//    guarding a hand-edited registry field. `reason: 'dispose'` (an explicit, requested
//    shutdown) is the only value treated as a clean stop; every other value (`sighup`, or
//    anything else actually present) counts as unexpected.
// 2. No exit record, but the tail's last assistant message carries `stopReason: 'aborted'`
//    (`OmpAssistantMessage`'s own `[key: string]: unknown` bag -- "provider bookkeeping Refract
//    does not read" until now; confirmed present on a real forensic read, issue #510 evidence:
//    "assistant tool-call entries have stopReason, 'aborted'").
// 3. No exit record and no aborted marker, but an assistant `toolCall` content part has no
//    matching `toolResult` message anywhere after it in the tail: the process stopped mid-call.
// Absent all three, the tail shows nothing wrong -- `clean`, which also covers "there genuinely
// was no problem" and "the window read did not happen to capture the trouble" alike; this
// function only ever reports what it can actually see.
import { promises as fs } from 'node:fs';

/** Never read more than this many bytes from the tail of a Conversation file (issue #510: "no
 * whole-file read"). Comfortably spans several turns' worth of tool calls plus one
 * `session_exit` record; far under OMP's own 64 MiB-per-message transport cap (`omp://rpc.md`). */
const TAIL_BYTES = 256 * 1024;

export type TerminationReason =
  | { kind: 'clean' }
  | { kind: 'exit-record'; reason: string }
  | { kind: 'aborted-message' }
  | { kind: 'unmatched-tool' };

export interface TerminationDetectionResult {
  terminatedUnexpectedly: boolean;
  reason: TerminationReason;
  /** Tool names left without a result, for the "terminated unexpectedly" banner/row text and the
   * eventual resume instruction (#509). Always `[]` when `terminatedUnexpectedly` is `false`. */
  pendingToolNames: string[];
}

const CLEAN_RESULT: TerminationDetectionResult = { terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] };

/** One raw `.jsonl` tail line, classified down to only the fields this module reads -- every
 * field access below is `in`/`typeof` narrowed against the actual JSON, never cast to an assumed
 * interface, since a stored Conversation line is disk content at the same trust level as
 * `registry.json`. */
type TailLine =
  | { kind: 'session-exit'; reason?: string; pendingToolCalls?: string[] }
  | { kind: 'assistant'; aborted: boolean; toolCalls: Array<{ id: string; name: string }> }
  | { kind: 'tool-result'; toolCallId: string }
  | { kind: 'user' }
  | { kind: 'other' };

function parseTailLine(line: string): TailLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
    // Only the file's true last line can land in the catch below (see readTailLines): a
    // genuinely truncated write, treated as inconclusive rather than asserted as a specific
    // reason -- the caller still sees whatever earlier, fully-parsed lines in the window found.
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  if ('type' in parsed && parsed.type === 'session_exit') {
    const reason = 'reason' in parsed && typeof parsed.reason === 'string' ? parsed.reason : undefined;
    const pendingToolCalls =
      'pendingToolCalls' in parsed && Array.isArray(parsed.pendingToolCalls)
        ? parsed.pendingToolCalls.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
    return { kind: 'session-exit', reason, pendingToolCalls };
  }

  if (!('type' in parsed) || parsed.type !== 'message' || !('message' in parsed)) return { kind: 'other' };
  const message = parsed.message;
  if (typeof message !== 'object' || message === null || !('role' in message)) return { kind: 'other' };

  if (message.role === 'assistant') {
    const aborted = 'stopReason' in message && message.stopReason === 'aborted';
    const toolCalls: Array<{ id: string; name: string }> = [];
    if ('content' in message && Array.isArray(message.content)) {
      for (const part of message.content) {
        const isToolCallPart =
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'toolCall' &&
          'id' in part &&
          typeof part.id === 'string' &&
          'name' in part &&
          typeof part.name === 'string';
        if (isToolCallPart) toolCalls.push({ id: part.id, name: part.name });
      }
    }
    return { kind: 'assistant', aborted, toolCalls };
  }
  if (message.role === 'toolResult' && 'toolCallId' in message && typeof message.toolCallId === 'string') {
    return { kind: 'tool-result', toolCallId: message.toolCallId };
  }
  if (message.role === 'user') return { kind: 'user' };
  return { kind: 'other' };
}

/** Reads at most the last `TAIL_BYTES` bytes of `file`, split into lines. The window's own FIRST
 * line is always dropped unless the whole file fit inside the window (it may be a fragment of an
 * earlier, larger line -- an artefact of where the window happened to start, not of the process
 * dying). The window always runs through to the file's true end-of-file, so if the LAST line
 * fails to parse later, that is real evidence of a write interrupted mid-record, never a
 * windowing artefact. Never throws: a missing, empty, or unreadable file yields `[]`. */
async function readTailLines(file: string): Promise<string[]> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0) return [];
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/** Issue #510 slice 1 (PLAN.md row A0): the sole entry point. `file === null` (no Conversation
 * has ever been started) is always `clean` with no file access attempted. */
export async function detectUnexpectedTermination(file: string | null): Promise<TerminationDetectionResult> {
  if (!file) return CLEAN_RESULT;
  const lines = await readTailLines(file);

  let exitRecord: { reason?: string; pendingToolCalls?: string[] } | undefined;
  let lastAssistantAborted = false;
  const outstandingToolCalls = new Map<string, string>(); // toolCallId -> toolName

  for (const line of lines) {
    const parsed = parseTailLine(line);
    if (!parsed) continue;
    switch (parsed.kind) {
      case 'session-exit':
        exitRecord = { reason: parsed.reason, pendingToolCalls: parsed.pendingToolCalls };
        break;
      case 'assistant':
        lastAssistantAborted = parsed.aborted;
        for (const call of parsed.toolCalls) outstandingToolCalls.set(call.id, call.name);
        break;
      case 'tool-result':
        outstandingToolCalls.delete(parsed.toolCallId);
        lastAssistantAborted = false; // a result landed after the abort marker: no longer trailing
        break;
      case 'user':
        lastAssistantAborted = false; // a later user turn means the abort is not the trailing entry
        break;
      case 'other':
        break;
    }
  }

  const pendingToolNames = [...outstandingToolCalls.values()];

  if (exitRecord) {
    const reasonValue = exitRecord.reason ?? 'unknown';
    const recordPending = exitRecord.pendingToolCalls ?? pendingToolNames;
    if (reasonValue === 'dispose') return CLEAN_RESULT;
    return { terminatedUnexpectedly: true, reason: { kind: 'exit-record', reason: reasonValue }, pendingToolNames: recordPending };
  }

  if (lastAssistantAborted) {
    return { terminatedUnexpectedly: true, reason: { kind: 'aborted-message' }, pendingToolNames };
  }

  if (pendingToolNames.length > 0) {
    return { terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' }, pendingToolNames };
  }

  return CLEAN_RESULT;
}
