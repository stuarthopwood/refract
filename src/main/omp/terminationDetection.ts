// Issue #510 (PLAN.md row A0, slice 1): tells whether the agent process that was writing a
// Conversation `.jsonl` went away unexpectedly, reading only the TAIL of that file -- never the
// whole thing (a real session file in the issue's own forensic read was 48 MB; this must also
// work cold, before any `omp` process has even been spawned this run, so it cannot depend on a
// live RPC or frame).
//
// Signal, checked in this order, judging the LAST process life in the window on its own (quality
// gate, 2026-10-08): an older crash resumed and superseded by later activity must never still
// read as "terminated unexpectedly" just because its exit record has not yet scrolled out of the
// 256 KiB window.
// 1. A trailing `session_exit` record. [INFERENCE: shape `{type:'session_exit', reason,
//    pendingToolCalls?}`, per the issue's own forensic read of a real session file -- the exact
//    field names are an open question (PLAN.md open question #13, "are the `reason` and `kind`
//    values stable across 18.4.x, 18.5.x and 18.6.3" -- not yet probed against a live binary).
//    Every field is read through `in`/`typeof` narrowing, never an assumed-shape cast: an
//    unexpected record is tolerated, same discipline as `transcript.ts`'s `currentTurnKeys`
//    guarding a hand-edited registry field. `reason: 'dispose'` (an explicit, requested
//    shutdown) is the only value treated as a clean stop; every other value (`sighup`, or
//    anything else actually present) counts as unexpected -- but ONLY when it is still the
//    trailing entry: any assistant, user, or tool-result line seen AFTER it means that life was
//    resumed and this exit record is now history, not evidence of the CURRENT stop.
// 2. No trailing exit record, but an assistant `toolCall` content part has no matching
//    `toolResult` message anywhere later in the window: the process stopped mid-call.
// A trailing assistant message with `stopReason: 'aborted'` is deliberately NOT treated as its
// own signal (quality gate, 2026-10-08): `SessionAgent.stop()` writes the same marker for an
// ordinary user-requested Stop, and whether OMP also writes a `session_exit` record for that
// case is unconfirmed (open question #13). Asserting it would flag every plain Stop as a crash.
// It still contributes via rule 2 above when the aborted message itself carries an unresolved
// tool call.
// Absent both signals, the tail shows nothing wrong -- `clean`, which also covers "there
// genuinely was no problem" and "the window read did not happen to capture the trouble" alike;
// this function only ever reports what it can actually see.
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Never read more than this many bytes from the tail of a Conversation file on the first pass
 * (issue #510: "no whole-file read"). Comfortably spans several turns' worth of tool calls plus
 * one `session_exit` record; far under OMP's own 64 MiB-per-message transport cap
 * (`omp://rpc.md`). */
const TAIL_BYTES = 256 * 1024;

/** Quality-gate fix: a single content line (e.g. a `write` tool's `arguments` for a file over
 * 256 KiB) can be bigger than `TAIL_BYTES`, in which case the naive "drop the window's own
 * partial first line" rule would drop the ONLY line and read nothing. `readTailLines` retries
 * with a doubled window (up to this cap) until it sees a real newline inside it, or gives up and
 * accepts the loss rather than reading the whole file regardless of its size. */
const MAX_TAIL_BYTES = TAIL_BYTES * 8;

export type TerminationReason =
  | { kind: 'clean' }
  | { kind: 'exit-record'; reason: string }
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
  | { kind: 'assistant'; toolCalls: Array<{ id: string; name: string }> }
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
    return { kind: 'assistant', toolCalls };
  }
  if (message.role === 'toolResult' && 'toolCallId' in message && typeof message.toolCallId === 'string') {
    return { kind: 'tool-result', toolCallId: message.toolCallId };
  }
  if (message.role === 'user') return { kind: 'user' };
  return { kind: 'other' };
}

/** Reads one window of `file`, `windowBytes` wide, ending at its current size. Returns the lines
 * and whether the window's own start actually sits at byte 0 (meaning no earlier content was
 * ever truncated away, so every line is real, including a lone huge first one). */
async function readWindow(handle: FileHandle, windowBytes: number): Promise<{ lines: string[]; startedAtZero: boolean } | undefined> {
  let stat;
  try {
    stat = await handle.stat();
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size === 0) return { lines: [], startedAtZero: true };
  const start = Math.max(0, stat.size - windowBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, start));
  } catch {
    return undefined;
  }
  const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
  return { lines, startedAtZero: start === 0 };
}

/** Reads at most `TAIL_BYTES` (doubling up to `MAX_TAIL_BYTES` only for the pathological single-
 * oversized-line case) from the tail of `file`. The window's own first line is dropped unless it
 * starts at the file's true byte 0 (it may be a fragment of an earlier, larger line -- an
 * artefact of where the window happened to start, not of the process dying). The window always
 * runs through to the file's true end-of-file, so if the LAST line fails to parse later, that is
 * real evidence of a write interrupted mid-record, never a windowing artefact. Never throws: a
 * missing, empty, or unreadable file (including a read that fails partway through) yields `[]`. */
async function readTailLines(file: string): Promise<string[]> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return [];
  }
  try {
    let windowBytes = TAIL_BYTES;
    for (;;) {
      const window = await readWindow(handle, windowBytes);
      if (!window) return [];
      const { lines, startedAtZero } = window;
      if (startedAtZero) return lines;
      // The window's own first line is always dropped here: it may be a fragment of an earlier,
      // larger line, never real evidence either way.
      const candidate = lines.slice(1);
      const hasRealContent = candidate.some((candidateLine) => candidateLine.trim().length > 0);
      if (hasRealContent || windowBytes >= MAX_TAIL_BYTES) return candidate;
      // Every remaining "line" is blank: the single real line here is bigger than the whole
      // window (e.g. a `write` tool call's `arguments` over 256 KiB). Double the window and try
      // again, up to the cap, then accept the loss rather than ever reading the entire file
      // regardless of its size.
      windowBytes *= 2;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function computeDetection(file: string): Promise<TerminationDetectionResult> {
  const lines = await readTailLines(file);

  let exitRecord: { reason?: string; pendingToolCalls?: string[] } | undefined;
  const outstandingToolCalls = new Map<string, string>(); // toolCallId -> toolName

  for (const line of lines) {
    const parsed = parseTailLine(line);
    if (!parsed) continue;
    switch (parsed.kind) {
      case 'session-exit':
        // Quality-gate fix: this life's own exit record and its own evidence -- never inherit an
        // EARLIER life's still-outstanding calls into it (those were this record's business, and
        // this record already carries its own `pendingToolCalls`, read below).
        exitRecord = { reason: parsed.reason, pendingToolCalls: parsed.pendingToolCalls };
        outstandingToolCalls.clear();
        break;
      case 'assistant':
        // Quality-gate fix: an assistant turn after an exit record means that crash was resumed
        // and superseded -- it is no longer the TRAILING entry this detector cares about.
        exitRecord = undefined;
        for (const call of parsed.toolCalls) outstandingToolCalls.set(call.id, call.name);
        break;
      case 'tool-result':
        exitRecord = undefined;
        outstandingToolCalls.delete(parsed.toolCallId);
        break;
      case 'user':
        exitRecord = undefined;
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

  if (pendingToolNames.length > 0) {
    return { terminatedUnexpectedly: true, reason: { kind: 'unmatched-tool' }, pendingToolNames };
  }

  return CLEAN_RESULT;
}

/** Quality-gate fix: `summaries()` runs this for every stopped (non-archived) Session on every
 * list refresh -- `session:list-changed` fires for any Session's rename, archive, or status
 * change, not just this one's. Caching by `(file, size, mtimeMs)` means an unrelated refresh
 * costs a cheap `fs.stat` instead of a repeat 256 KiB read for every Session whose Conversation
 * has not actually changed since the last call. */
const cache = new Map<string, { size: number; mtimeMs: number; promise: Promise<TerminationDetectionResult> }>();

/** Issue #510 slice 1 (PLAN.md row A0): the sole entry point. `file === null` (no Conversation
 * has ever been started) is always `clean` with no file access attempted. */
export async function detectUnexpectedTermination(file: string | null): Promise<TerminationDetectionResult> {
  if (!file) return CLEAN_RESULT;
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    cache.delete(file);
    return CLEAN_RESULT;
  }
  const cached = cache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.promise;
  const promise = computeDetection(file);
  cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, promise });
  return promise;
}
