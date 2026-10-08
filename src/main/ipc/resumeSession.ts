// Issue #509 quality-gate fix (cycle 2, 2026-10-08): the SESSIONS_RESUME handler's own body,
// pulled out so the per-session lock, the eligibility re-check, and the recover-then-send
// sequence are unit-testable against injected fakes -- the prior round's own
// `resumeEligibility.test.ts` only ever pre-filled the lock Set and called the pure
// `checkResumeEligible`, which proved that function works but never proved the HANDLER actually
// adds to the lock before any `await`, releases it in `finally` on every exit path, or sends the
// instruction exactly once under real concurrency.
import type { Result, SessionRuntimeView, SessionSnapshot } from '../../shared/ipc';
import type { ImageContent } from '../../shared/frames';
import type { Session, SessionStatus } from '../../shared/model';
import { DEFAULT_RESUME_INSTRUCTION } from '../../shared/model';
import type { TerminationDetectionResult } from '../omp/terminationDetection';
import { resolveTermination } from '../omp/stoppedOnRequestMarker';
import { checkResumeEligible } from './resumeEligibility';
import type { ResumeRefusalCode } from './resumeEligibility';
import { notFound } from './util';

const RESUME_REFUSAL_MESSAGE: Record<ResumeRefusalCode, string> = {
  'already-resuming': 'A resume for this Session is already in progress.',
  'not-stopped': 'Session is not stopped.',
  'not-eligible': 'Session is not eligible to resume.',
};

/** The one piece of a real `SessionAgent` this needs -- narrowed so a test can supply a fake
 * without constructing a real process. */
export interface ResumableAgent {
  runtimeSnapshot: {
    status: SessionStatus;
    stopReason?: SessionRuntimeView['stopReason'];
    stoppedOnRequest: boolean;
  };
  start(): Promise<unknown>;
  send(text: string, images?: ImageContent[]): Promise<unknown>;
}

export interface ResumeSessionDeps {
  getSession(id: string): Session | undefined;
  getOrCreateAgent(id: string): ResumableAgent;
  notifyListChanged(): void;
  detectUnexpectedTermination(file: string | null): Promise<TerminationDetectionResult>;
  buildSnapshot(agent: ResumableAgent, session: Session): Promise<SessionSnapshot>;
}

/** `resumingIds` is owned by the caller (one `Set` per `registerSessions` call, shared across
 * every invocation for the life of the app) so the lock genuinely spans concurrent IPC calls,
 * not just this one function's own stack frame. Added to synchronously, with no `await` between
 * the eligibility check and the add, so two calls arriving back to back can never both pass. */
export async function resumeSessionCore(resumingIds: Set<string>, id: string, deps: ResumeSessionDeps): Promise<Result<SessionSnapshot>> {
  const session = deps.getSession(id);
  if (!session) return notFound(`Session not found: ${id}`);
  // Quality-gate fix (cycle 5, 2026-10-08): refused before the tail read (never worth a 256 KiB
  // file read for a Session Resume can never apply to) -- requirement 1 says "not for ...
  // archived Sessions", but an archived Session whose agent crashed this run before being
  // archived keeps `stopReason: 'agent-exited'` (archive's own `shutdown()` is a no-op with no
  // live process), which this handler would otherwise accept and send a real turn into.
  if (session.archivedAt) {
    return { ok: false, error: { code: 'invalid-argument', message: RESUME_REFUSAL_MESSAGE['not-eligible'] } };
  }
  const agent = deps.getOrCreateAgent(id);
  // Quality-gate fix (cycle 2, 2026-10-08): a requested stop is never eligible to resume (it is
  // never "terminated unexpectedly" by definition) -- see `SessionRuntime.stoppedOnRequest`'s
  // own doc comment. Never reads the tail for one. `resolveTermination` (cycle 5: shared, not
  // copied here) also checks the persisted marker alongside `agent.runtimeSnapshot.
  // stoppedOnRequest` (THIS life's own in-memory flag) so resuming a Session reattached fresh
  // after an app restart still refuses correctly (`not-eligible`, never `agent-exited`'s own
  // resumable state) for a stop that was only ever requested, as long as the Conversation has
  // not grown since (see `Session.stoppedOnRequestConversation`'s own doc comment).
  // `deps.detectUnexpectedTermination` is passed through explicitly (not `resolveTermination`'s
  // own default) so this function's existing dependency-injection tests keep controlling it.
  const detection = await resolveTermination(session, agent.runtimeSnapshot.stoppedOnRequest, deps.detectUnexpectedTermination);
  // Quality-gate fix (cycle 7, 2026-10-08, security-auditor, Medium): `session` above was read
  // BEFORE the `await` just above -- `RegistryStore.updateSession` (registry.ts) replaces the
  // array entry with a brand-new object rather than mutating in place, so a Session archived by
  // a concurrent SESSIONS_ARCHIVE call DURING that await is invisible to the stale `session`
  // reference. Re-read fresh right here, before the eligibility check, and use `fresh` (never
  // the stale `session`) for both the archived flag and every subsequent read below.
  const fresh = deps.getSession(id);
  if (!fresh || fresh.archivedAt) {
    return { ok: false, error: { code: 'invalid-argument', message: RESUME_REFUSAL_MESSAGE['not-eligible'] } };
  }
  const refusal = checkResumeEligible(
    resumingIds,
    id,
    agent.runtimeSnapshot.status,
    agent.runtimeSnapshot.stopReason,
    detection.terminatedUnexpectedly,
    !!fresh.archivedAt,
  );
  if (refusal) {
    return { ok: false, error: { code: 'invalid-argument', message: RESUME_REFUSAL_MESSAGE[refusal] } };
  }
  resumingIds.add(id);
  try {
    await agent.start().catch(() => undefined);
    deps.notifyListChanged();
    const refreshed = deps.getSession(id) ?? fresh;
    const snapshot = await deps.buildSnapshot(agent, refreshed);
    if (snapshot.runtime.status === 'stopped') {
      // The restart itself failed (e.g. start-failed): never send the instruction into a
      // Session that did not actually come back.
      return { ok: true, value: snapshot };
    }
    try {
      await agent.send(DEFAULT_RESUME_INSTRUCTION);
    } catch (err) {
      return { ok: false, error: { code: 'prompt-failed', message: err instanceof Error ? err.message : String(err) } };
    }
    // Quality-gate fix (cycle 7, 2026-10-08, code-reviewer, Medium): `snapshot` above was built
    // BEFORE `agent.send` -- returning it here would let the renderer's
    // `applySnapshotExceptTranscript` stomp the live stores with that stale pre-send state,
    // dropping any `pending:add`/`queue_update`/`readout:update` live event that arrived during
    // the send window even though main still holds it (e.g. an approval request the user would
    // then never see, constitution II: every request must be answered). Build a FRESH snapshot
    // after `send` resolves so the returned value reflects whatever actually landed meanwhile.
    const postSend = deps.getSession(id) ?? refreshed;
    return { ok: true, value: await deps.buildSnapshot(agent, postSend) };
  } finally {
    resumingIds.delete(id);
  }
}
