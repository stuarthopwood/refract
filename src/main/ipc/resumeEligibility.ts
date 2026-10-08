// Issue #509 (PLAN.md row A2g) quality-gate fix: the gating half of `sessions.resume`
// (ipc/sessions.ts) -- the per-session lock check and the server-side eligibility re-check --
// pulled out so the part most likely to silently regress (a lock that stops guarding a
// concurrent second call, or an eligibility check that drifts from `canResumeSession`) is
// unit-testable without a live SessionAgent/Electron. `resumingIds` stays owned by the caller:
// this never mutates it, so the caller is still the one place that adds/removes the id around
// its own `agent.start()`/`agent.send()`.
import type { SessionStatus } from '../../shared/model';
import type { SessionRuntimeView } from '../../shared/ipc';
import { canResumeSession } from '../../shared/canResumeSession';

export type ResumeRefusalCode = 'already-resuming' | 'not-stopped' | 'not-eligible';

/** `null` means the resume may proceed. Never trusts a client-computed "it's safe to resume" --
 * `status`/`stopReason`/`terminatedUnexpectedly` here must be freshly read (a fresh tail read for
 * the last one), never values the renderer's click happened to be holding, since a second pane
 * could have already recovered this exact Session in the meantime. */
export function checkResumeEligible(
  resumingIds: ReadonlySet<string>,
  id: string,
  status: SessionStatus,
  stopReason: SessionRuntimeView['stopReason'],
  terminatedUnexpectedly: boolean,
  archived: boolean,
): ResumeRefusalCode | null {
  if (resumingIds.has(id)) return 'already-resuming';
  if (status !== 'stopped') return 'not-stopped';
  if (!canResumeSession(status, stopReason, terminatedUnexpectedly, archived)) return 'not-eligible';
  return null;
}
