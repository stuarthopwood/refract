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
  const agent = deps.getOrCreateAgent(id);
  // Quality-gate fix (cycle 2, 2026-10-08): a requested stop is never eligible to resume (it is
  // never "terminated unexpectedly" by definition) -- see `SessionRuntime.stoppedOnRequest`'s
  // own doc comment. Never reads the tail for one.
  const detection = agent.runtimeSnapshot.stoppedOnRequest
    ? { terminatedUnexpectedly: false, reason: { kind: 'clean' as const }, pendingToolNames: [] }
    : await deps.detectUnexpectedTermination(session.currentConversation);
  const refusal = checkResumeEligible(
    resumingIds,
    id,
    agent.runtimeSnapshot.status,
    agent.runtimeSnapshot.stopReason,
    detection.terminatedUnexpectedly,
  );
  if (refusal) {
    return { ok: false, error: { code: 'invalid-argument', message: RESUME_REFUSAL_MESSAGE[refusal] } };
  }
  resumingIds.add(id);
  try {
    await agent.start().catch(() => undefined);
    deps.notifyListChanged();
    const refreshed = deps.getSession(id) ?? session;
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
    return { ok: true, value: snapshot };
  } finally {
    resumingIds.delete(id);
  }
}
