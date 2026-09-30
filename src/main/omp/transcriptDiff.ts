import type { TranscriptItem } from '../../shared/model';
import type { TranscriptOp } from '../../shared/ipc';

/**
 * Builds the `TranscriptOp[]` to bring a subscriber from `prev` to `next`. `transcript.ts`
 * preserves object identity for items it did not touch (see `replaceMessageItems`), so an
 * unchanged item is the same reference in both arrays; anything new or changed is a fresh object
 * and becomes an `upsert`. If any item present in `prev` is gone from `next` (no `TranscriptOp`
 * models deletion), the whole snapshot is resent as a `reset`.
 */
export function diffTranscript(prev: TranscriptItem[], next: TranscriptItem[]): TranscriptOp[] {
  if (prev.length === 0) {
    return next.length === 0 ? [] : [{ op: 'reset', items: next }];
  }
  const nextIds = new Set(next.map((item) => item.id));
  const anyRemoved = prev.some((item) => !nextIds.has(item.id));
  if (anyRemoved) {
    return [{ op: 'reset', items: next }];
  }
  const ops: TranscriptOp[] = [];
  for (const item of next) {
    const before = prev.find((candidate) => candidate.id === item.id);
    if (!before || before !== item) {
      ops.push({ op: 'upsert', item });
    }
  }
  return ops;
}

/** `start()`/`restart()`/`openConversation()` each fetch full history with `get_messages` and
 * would otherwise flat-replace `runtime.transcript` with it, silently dropping anything a live
 * frame appended (a pending request, or an in-flight tool/message OMP has not yet persisted)
 * while that round trip was in flight. Keeps every `historyTranscript` item in its persisted
 * order, then appends any `liveTranscript` item not already present by id. */
export function mergeLiveTranscript(historyTranscript: TranscriptItem[], liveTranscript: TranscriptItem[]): TranscriptItem[] {
  const historyIds = new Set(historyTranscript.map((item) => item.id));
  const extra = liveTranscript.filter((item) => !historyIds.has(item.id));
  return extra.length === 0 ? historyTranscript : [...historyTranscript, ...extra];
}
