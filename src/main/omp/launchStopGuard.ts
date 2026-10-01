import type { OmpProcess } from './OmpProcess';

/**
 * `SessionAgent.shutdown()` (archive/delete/stopAgent/stopAll) and a mode-change `restart()` can
 * race: `doRestart()`'s own internal stop already clears `process` before `launch()` respawns a
 * replacement, so a naive `shutdown()` that only checks `process` right then sees nothing to
 * stop and returns -- while the restart goes on to spawn an orphaned `omp` for a Session that is
 * being archived/deleted/stopped, still holding its worktree cwd.
 *
 * `SessionAgent.stopRequested` closes that window: `shutdown()` sets it (and drains any
 * in-flight `start()`/`restart()` before stopping the process itself), and `launch()` checks it
 * right here, after `proc.start()` and again after `attachAndVerify()` -- the two points where a
 * concurrent `shutdown()` could have raced it. Not a real failure: no error notice, no
 * `start-failed` status; the caller instead moves the Session straight to `stopped`/
 * `not-started`, the same status a deliberate `proc.stop()` produces anywhere else.
 */
export async function bailIfStopRequested(
  stopRequested: boolean,
  proc: OmpProcess,
  onBail: () => void,
): Promise<{ ok: false; error: unknown } | undefined> {
  if (!stopRequested) return undefined;
  await proc.stop();
  onBail();
  return { ok: false, error: new Error('SessionAgent: stop requested during launch') };
}

/** Stops `proc` if there is one; a no-op once already exited or never started. Used by both
 * `shutdown()` and `doRestart()`'s own internal stop -- the latter must not set `stopRequested`
 * (it is about to spawn a replacement, not disposing the Session). */
export async function stopIfRunning(proc: OmpProcess | undefined): Promise<void> {
  if (!proc) return;
  await proc.stop();
}

/** `launch()` guard: fires `onFail` and builds the failure result when a concurrent exit cleared
 * `this.process` out from under an in-flight launch attempt (the running turn no longer owns a
 * live process). `stillCurrent` is the caller's `this.process === proc` check. */
export function exitedDuringStart(
  stillCurrent: boolean,
  failurePrefix: string,
  onFail: (detail: string) => void,
): { ok: false; error: unknown } | undefined {
  if (stillCurrent) return undefined;
  const detail = failurePrefix + 'agent exited during start';
  onFail(detail);
  return { ok: false, error: new Error(detail) };
}
