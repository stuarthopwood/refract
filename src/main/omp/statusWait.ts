// Extracted from `SessionAgent.waitForIdle` (kept SessionAgent.ts under the 800-line budget,
// tasks.md). Resolves once `currentStatus` (read fresh by the caller before calling in) is
// already `idle`/`stopped`, otherwise waits for the next `status` event that reaches one of
// those, or rejects on `timeoutMs`. Used by `SessionAgent.stop()` after sending `abort`.
import type { SessionStatus } from '../../shared/model';
import type { SessionStatusEvent } from '../../shared/ipc';

export interface StatusEmitter {
  on(event: 'status', listener: (payload: SessionStatusEvent) => void): unknown;
  off(event: 'status', listener: (payload: SessionStatusEvent) => void): unknown;
}

export function waitForIdleStatus(
  emitter: StatusEmitter,
  currentStatus: SessionStatus,
  timeoutMs: number,
  sessionId: string,
): Promise<void> {
  if (currentStatus === 'idle' || currentStatus === 'stopped') return Promise.resolve();
  // Promise.withResolvers() would read cleaner here, but it needs lib "ES2024" and
  // tsconfig.node.json is pinned to "ES2023" (see OmpProcess.ts's start()); executor form kept.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('status', onStatus);
      reject(new Error(`SessionAgent ${sessionId}: timed out waiting for idle`));
    }, timeoutMs);
    const onStatus = (payload: SessionStatusEvent): void => {
      if (payload.status !== 'idle' && payload.status !== 'stopped') return;
      clearTimeout(timer);
      emitter.off('status', onStatus);
      resolve();
    };
    emitter.on('status', onStatus);
  });
}
