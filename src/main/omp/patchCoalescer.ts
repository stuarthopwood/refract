import type { TranscriptItem } from '../../shared/model';
import type { TranscriptOp } from '../../shared/ipc';

const PATCH_COALESCE_MS = 50;

/**
 * Coalesces `transcript:patch` events to at most one per Session per `PATCH_COALESCE_MS` window
 * (contracts/ipc.md `transcript:patch`). Extracted out of `SessionAgent` so that class stays
 * within its line budget; `emit` is the caller's way to actually publish a batch of ops.
 */
export class PatchCoalescer {
  private pendingOps: TranscriptOp[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly emit: (ops: TranscriptOp[]) => void) {}

  /** Queues `ops`, flushing every op queued so far after `PATCH_COALESCE_MS` of quiet. */
  queue(ops: TranscriptOp[]): void {
    this.pendingOps.push(...ops);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const flushed = this.pendingOps;
      this.pendingOps = [];
      if (flushed.length === 0) return;
      this.emit(flushed);
    }, PATCH_COALESCE_MS);
  }

  /** Full-snapshot flush: cancels any coalesced ops still pending (they are against the
   * pre-reset transcript, so flushing them afterward would reapply stale operations on top of
   * the fresh snapshot) and emits a single `reset` with `items`. */
  reset(items: TranscriptItem[]): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingOps = [];
    this.emit([{ op: 'reset', items }]);
  }
}
