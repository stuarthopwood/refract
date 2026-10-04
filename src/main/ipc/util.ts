import type { Result, SessionSnapshot, SessionRuntimeView } from '../../shared/ipc';
import type { Session } from '../../shared/model';
import { listConversations } from '../conversations';
import { ReattachFailedError, SessionNotIdleError } from '../omp/errors';
import type { SessionAgent } from '../omp/SessionAgent';
import { GitError } from '../git/git';
import { RegistryError } from '../store/registry';

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
  return { ok: false, error: { code: 'git-failed', message: err instanceof Error ? err.message : String(err) } };
}

export async function buildSnapshot(agent: SessionAgent, session: Session): Promise<SessionSnapshot> {
  // Spec 004: `turnStartedAt`/`subagents` are main-only bookkeeping (the renderer reads the
  // derived `readout`/`subagents:update` instead), so they are excluded from `SessionRuntimeView`
  // rather than sent twice over IPC.
  const { turnStartedAt: _turnStartedAt, readout, subagents: _subagents, ...runtimeFields } = agent.runtimeSnapshot;
  const runtime: SessionRuntimeView = runtimeFields;
  const conversations = await listConversations(session.sessionDir, session.currentConversation);
  return { runtime, conversations, readout };
}
