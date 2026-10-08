import type { Result, SessionSnapshot, SessionRuntimeView } from '../../shared/ipc';
import type { Session } from '../../shared/model';
import { listConversations } from '../conversations';
import { ReattachFailedError, SessionNotIdleError } from '../omp/errors';
import type { SessionAgent } from '../omp/SessionAgent';
import { resolveTermination } from '../omp/stoppedOnRequestMarker';
import type { TerminationDetectionResult } from '../omp/terminationDetection';
import { GitError } from '../git/git';
import { RegistryError } from '../store/registry';
import { GhError } from '../github/gh';

export function invalidArgument(message: string): Result<never> {
  return { ok: false, error: { code: 'invalid-argument', message } };
}

export function notFound(message: string): Result<never> {
  return { ok: false, error: { code: 'not-found', message } };
}

export function mapSessionThrown(err: unknown): Result<never> {
  if (err instanceof SessionNotIdleError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof ReattachFailedError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) } };
}

export function mapStoreThrown(err: unknown): Result<never> {
  if (err instanceof GitError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof RegistryError) return { ok: false, error: { code: err.code, message: err.message } };
  if (err instanceof GhError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: 'git-failed', message: err instanceof Error ? err.message : String(err) } };
}

export async function buildSnapshot(
  agent: SessionAgent,
  session: Session,
  precomputedDetection?: TerminationDetectionResult,
): Promise<SessionSnapshot> {
  // Spec 004: `turnStartedAt` is main-only bookkeeping (the renderer reads the derived `readout`
  // instead), so it is excluded from `SessionRuntimeView` rather than sent twice over IPC.
  // `subagents` (T024 live-finding fix) is different: it IS the renderer-facing shape
  // (`SubagentSummary[]`, the same one `subagents:update` pushes), so the top-level snapshot
  // still carries it as a seed -- dropping it here left the Subagent panel's list wiped back to
  // empty on every snapshot re-application (a Settings round-trip, a session switch away and
  // back), even while the chip's own `readout.subagentCount` correctly kept showing the count.
  // Gate-fixes Medium finding (cycle 6): `startProgress` is excluded from the spread too -- no
  // renderer code reads `snapshot.runtime.startProgress` any more (ChatPane derives it straight
  // from the sessions store, which `sessions.list()` and the live `session:status` event both
  // already feed), so `SessionRuntimeView` no longer declares the field at all.
  const { turnStartedAt: _turnStartedAt, stoppedOnRequest, startProgress: _startProgress, readout, subagents, ...runtimeFields } = agent.runtimeSnapshot;
  const runtime: SessionRuntimeView = runtimeFields;
  // Issue #510 slice 2 (PLAN.md row A0): only a stopped Session can be "terminated unexpectedly"
  // -- a live one's own status already says otherwise, so no tail read is spent on it. Issue #509
  // quality-gate fix: `attachSnapshot` (ipc/sessions.ts) already computes this very detection to
  // decide `canAutoStart`/`canResumeSession` before calling here -- passing it through avoids a
  // second 256 KiB read of the same file for the same call.
  if (runtime.status === 'stopped') {
    // Quality-gate fix (cycle 2, 2026-10-08): a requested stop is never read from the tail at
    // all -- see `SessionRuntime.stoppedOnRequest`'s own doc comment. Issue #509 quality-gate
    // fix: `attachSnapshot` (ipc/sessions.ts) may already have computed this very detection to
    // decide `canAutoStart`/`canResumeSession` before calling here -- passing it through avoids
    // a second 256 KiB read of the same file for the same call. `resolveTermination` (cycle 5:
    // shared, not copied here) is the fallback when nothing was precomputed; it also checks the
    // persisted marker alongside `stoppedOnRequest` so a Session reattached fresh this run still
    // honours an EARLIER life's requested stop, as long as the Conversation has not grown since
    // -- see `Session.stoppedOnRequestConversation`'s own doc comment.
    const detection = precomputedDetection ?? (await resolveTermination(session, stoppedOnRequest));
    runtime.terminatedUnexpectedly = detection.terminatedUnexpectedly;
    if (detection.pendingToolNames.length > 0) runtime.pendingToolNames = detection.pendingToolNames;
  }
  const conversations = await listConversations(session.sessionDir, session.currentConversation);
  return { runtime, conversations, readout, subagents };
}
