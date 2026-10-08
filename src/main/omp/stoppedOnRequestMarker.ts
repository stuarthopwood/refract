// Issue #510 quality-gate fix (cycle 4, 2026-10-08): a persisted sibling of `SessionRuntime.
// stoppedOnRequest` for the Session (`registry.json`, data-model.md), so a deliberate stop
// survives an app restart. `SessionRuntime` is in-memory only and gone the moment a Session's
// `SessionAgent` is garbage (every restart, since `SessionManager` only creates agents lazily on
// first access) -- without this, `summaries()`/`buildSnapshot`/`attachSnapshot` all re-derive
// `terminatedUnexpectedly` fresh from the Conversation tail for a Session with no live runtime,
// and a tool call still outstanding when a REQUESTED stop fired looks identical, from the file
// alone, to a genuine mid-call crash (the exact ambiguity `stoppedOnRequest` exists to resolve,
// just without surviving past this run).
import { promises as fs } from 'node:fs';
import type { Session } from '../../shared/model';
import type { RegistryStore } from '../store/registry';
import { detectUnexpectedTermination } from './terminationDetection';
import type { TerminationDetectionResult } from './terminationDetection';

/** Writes the marker for `session`'s CURRENT Conversation at the moment of a requested stop
 * (`SessionAgent.onExit`'s requested branch). Stats the file for its exact size rather than
 * trusting any in-memory byte count -- the marker must describe what is ACTUALLY on disk, since
 * that is the only thing a later life (or a restarted app) can ever re-check it against. A
 * missing/unreadable Conversation (the agent stopped before its first turn) sets no marker: there
 * is nothing to protect a later read from in that case, an absent file already reads clean.
 * Never throws -- a failed write here must not crash the exit handler it runs from; the Session
 * simply falls back to judging the tail fresh next time, same as if this had never run.
 *
 * Quality-gate fix (cycle 5, 2026-10-08): `stillCurrent`, checked AFTER the `fs.stat` await and
 * BEFORE `updateSession`, closes a race with `launch()`'s own `clearStoppedOnRequestMarker`: a
 * requested stop followed quickly by a new life starting (a user send that auto-starts, a
 * recover, Stop-then-Start) can run clear-then-record in that order if this call's own `stat`
 * is still in flight when the new `launch()` fires its clear -- without the check, this call
 * would then re-arm the marker for the NEW life after the clear meant to protect it, and a crash
 * in that new life before it writes anything (the exact case the active clear exists for) would
 * be masked as a mere requested stop. Defaults to always-current for callers that have no
 * narrower life concept to check (there are none today; every real caller is `SessionAgent`). */
export async function recordStoppedOnRequestMarker(
  registry: RegistryStore,
  sessionId: string,
  conversation: string | null,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  if (!conversation) return;
  let size: number;
  try {
    ({ size } = await fs.stat(conversation));
  } catch {
    return;
  }
  if (!stillCurrent()) return;
  await registry
    .updateSession(sessionId, { stoppedOnRequestConversation: conversation, stoppedOnRequestAtSize: size })
    .catch((err) => console.error(`stoppedOnRequestMarker: failed to record marker for ${sessionId}`, err));
}

/** Clears the marker -- called at the top of every `SessionAgent.launch()` attempt, the exact
 * same place the in-memory `stoppedOnRequest`/`lifeEpoch` both reset: a new life starting means
 * whatever the PREVIOUS life's requested stop protected no longer applies to THIS one. Without
 * this, a life that starts and crashes before writing anything new to the Conversation (so the
 * file's size genuinely has not changed) would otherwise still read as a protected, requested
 * stop -- the passive size-comparison in `isStoppedOnRequestMarkerValid` alone cannot catch that
 * case, since nothing about the file itself would differ. */
export async function clearStoppedOnRequestMarker(registry: RegistryStore, sessionId: string): Promise<void> {
  await registry
    .updateSession(sessionId, { stoppedOnRequestConversation: null, stoppedOnRequestAtSize: null })
    .catch((err) => console.error(`stoppedOnRequestMarker: failed to clear marker for ${sessionId}`, err));
}

/** True only when `session` carries a marker for its OWN current Conversation whose recorded
 * size still matches that file's real size on disk right now -- i.e. nothing has been appended
 * to it since the requested stop that set the marker. Any mismatch at all (no marker, a
 * different Conversation than the one marked, a non-number/negative/non-finite size from a
 * hand-edited or corrupt registry file, the file having grown, or the file now missing) returns
 * `false`: judge the tail fresh, exactly as if no marker had ever existed -- this function is a
 * narrow exception to tail-reading, never a replacement for it. Never throws. */
export async function isStoppedOnRequestMarkerValid(
  session: Pick<Session, 'currentConversation' | 'stoppedOnRequestConversation' | 'stoppedOnRequestAtSize'>,
): Promise<boolean> {
  const { currentConversation, stoppedOnRequestConversation, stoppedOnRequestAtSize } = session;
  if (!currentConversation) return false;
  if (typeof stoppedOnRequestConversation !== 'string' || stoppedOnRequestConversation !== currentConversation) return false;
  if (typeof stoppedOnRequestAtSize !== 'number' || !Number.isFinite(stoppedOnRequestAtSize) || stoppedOnRequestAtSize < 0) return false;
  try {
    const { size } = await fs.stat(currentConversation);
    return size === stoppedOnRequestAtSize;
  } catch {
    return false;
  }
}

const CLEAN_RESULT: TerminationDetectionResult = { terminatedUnexpectedly: false, reason: { kind: 'clean' }, pendingToolNames: [] };

/** Quality-gate fix (cycle 5, 2026-10-08, DRY): the "requested stop (in-memory flag or a valid
 * persisted marker) -> clean, else read the tail" rule was copied at every call site that needs
 * `terminatedUnexpectedly` (`SessionManager.summaries()` twice, `ipc/util.ts`'s `buildSnapshot`,
 * and #509's own `attachSnapshotCore`/`resumeSessionCore`) and had already drifted between them
 * (some synthesised their own `{ reason: { kind: 'clean' } }` result, others did not). One
 * shared implementation every call site now routes through instead. */
export async function resolveTermination(
  session: Pick<Session, 'currentConversation' | 'stoppedOnRequestConversation' | 'stoppedOnRequestAtSize'>,
  stoppedOnRequest: boolean,
): Promise<TerminationDetectionResult> {
  if (stoppedOnRequest || (await isStoppedOnRequestMarkerValid(session))) return CLEAN_RESULT;
  return detectUnexpectedTermination(session.currentConversation);
}
