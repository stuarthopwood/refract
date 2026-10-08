// Issue #509 quality-gate fix (cycle 3, 2026-10-08): `sessions.ts`'s own `attachSnapshot`
// closure, pulled out so the `stoppedOnRequest` short-circuit (FR-038: "stopAgent reattaches
// when reopened") and the `canAutoStart` gate are unit-testable against injected fakes -- same
// reasoning, and the same shape, as `resumeSessionCore`/`resumeSession.ts`: a prior cycle's own
// `canAutoStart.test.ts` only ever proved the pure `canAutoStart` function works, never that
// this HANDLER actually skips the tail read for a requested stop, or threads the computed
// `detection` into `buildSnapshot` instead of re-reading the file a second time.
import type { Result, SessionRuntimeView, SessionSnapshot } from '../../shared/ipc';
import type { Session } from '../../shared/model';
import type { TerminationDetectionResult } from '../omp/terminationDetection';
import { canAutoStart } from './canAutoStart';
import { notFound } from './util';
import { isStoppedOnRequestMarkerValid } from '../omp/stoppedOnRequestMarker';

/** The one piece of a real `SessionAgent` this needs -- narrowed so a test can supply a fake
 * without constructing a real process. */
export interface AttachableAgent {
  runtimeSnapshot: {
    status: SessionRuntimeView['status'];
    stopReason?: SessionRuntimeView['stopReason'];
    stoppedOnRequest: boolean;
  };
  start(): Promise<unknown>;
}

export interface AttachSnapshotDeps {
  getSession(id: string): Session | undefined;
  getOrCreateAgent(id: string): AttachableAgent;
  notifyListChanged(): void;
  detectUnexpectedTermination(file: string | null): Promise<TerminationDetectionResult>;
  buildSnapshot(agent: AttachableAgent, session: Session, detection?: TerminationDetectionResult): Promise<SessionSnapshot>;
}

/** `forceStart` makes `recover` (and an explicit user send, `sessions.ts`'s own `SESSIONS_OPEN`
 * handler) restart regardless of reason (including `agent-exited`); a passive `open` only starts
 * when `canAutoStart` says the Session was never wrong to begin with. The tail detection is
 * computed at most once here and threaded into `buildSnapshot` (avoids a second 256 KiB read of
 * the same file). */
export async function attachSnapshotCore(id: string, forceStart: boolean, deps: AttachSnapshotDeps): Promise<Result<SessionSnapshot>> {
  const session = deps.getSession(id);
  if (!session) return notFound(`Session not found: ${id}`);
  const agent = deps.getOrCreateAgent(id);
  let detection: TerminationDetectionResult | undefined;
  if (agent.runtimeSnapshot.status === 'stopped') {
    // A requested stop is never read from the tail at all -- see `SessionRuntime.stoppedOnRequest`'s
    // own doc comment. Without this, FR-038 broke for exactly the Session #510's own cycle 1 fix
    // was supposed to protect: a tool call still outstanding when the stop fired looks identical,
    // from the file alone, to a crash, so `canAutoStart` below would wrongly refuse to reattach a
    // Session the user only ever stopped on purpose. Quality-gate fix (cycle 4, 2026-10-08):
    // `agent.runtimeSnapshot.stoppedOnRequest` is THIS life's own in-memory flag, reset `false`
    // for a Session not yet started this run -- the persisted marker is checked alongside it so
    // reattaching fresh after an app restart still honours an EARLIER life's requested stop, as
    // long as the Conversation has not grown since (see `Session.stoppedOnRequestConversation`'s
    // own doc comment).
    detection = (agent.runtimeSnapshot.stoppedOnRequest || (await isStoppedOnRequestMarkerValid(session)))
      ? { terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] }
      : await deps.detectUnexpectedTermination(session.currentConversation);
    if (forceStart || canAutoStart(agent.runtimeSnapshot.stopReason, detection.terminatedUnexpectedly)) {
      await agent.start().catch(() => undefined);
      // T062: `agent.start()` runs `syncFromState` against the registry before resolving
      // (`lastModel`/`lastThinkingLevel`, `sessionDir`, ...), so the row the renderer already
      // cached from a previous `sessions.list()` is now stale; tell it to re-fetch, the same way
      // every other Session-row-affecting mutation in `sessions.ts` already does.
      deps.notifyListChanged();
    }
  }
  const refreshed = deps.getSession(id) ?? session;
  return { ok: true, value: await deps.buildSnapshot(agent, refreshed, detection) };
}
