import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcCommand } from '../../shared/frames';
import { OmpProcess } from './OmpProcess';

// Gate-fixes Medium finding (issue #512): this scratch probe shares the process-wide start
// queue with real Sessions; nothing shows a Keep waiting/Cancel banner for it, so the shorter
// ceiling below (matching the pre-#512 60s cap) is strictly better than either the old silent
// 60s kill or the new 180s Session default blocking the accounts screen behind a slow start.
// `PROBE_READY_CEILING_MS` alone only bounds the ready-wait phase once spawned; `startDeadlineMs`
// below (readiness.ts's same fix, gate-fixes Medium finding cycle 2) bounds the queue wait, the
// memory defer and the ready wait combined, so this probe can never block longer than that
// regardless of which phase it is stuck in. Gate-fixes High finding (cycle 5): that combined
// deadline used to run the memory defer inside it unconditionally too -- under low free memory
// the defer's own up-to-60s wait routinely ate this deadline before the ready-wait phase even
// started, so this probe always timed out; `deferForMemory: false` below skips that defer.
const PROBE_READY_PROMPT_AFTER_MS = 30_000;
const PROBE_READY_CEILING_MS = 60_000;
const PROBE_START_DEADLINE_MS = PROBE_READY_CEILING_MS;

export interface OmpLoginProvider {
 id: string;
 authenticated: boolean;
}

/**
 * Runs the read-only `get_login_providers` command against an already-running `proc` (research.md
 * decision 6, FINDINGS item 15) and returns the provider list. Never rejects: any failure --
 * request, malformed response -- resolves to `null` instead. Each provider's `id` is validated as
 * a string before being trusted (GateCode008 LOW: the raw RPC response is otherwise untyped).
 *
 * Split out of `readOmpLoginProviders` below (GateCode008 MEDIUM "the sign-in failure hint spins
 * up a second scratch omp"): `readiness.ts`'s `signedInFailureHint` already has a live probe
 * `OmpProcess` running when it needs this same data, so it calls this directly on that process
 * instead of `readOmpLoginProviders` spinning up an entirely separate scratch process alongside
 * the one still running.
 */
export async function requestLoginProviders(proc: OmpProcess): Promise<OmpLoginProvider[] | null> {
 try {
  const res = await proc.request({ type: 'get_login_providers', id: '' } as unknown as RpcCommand);
  if (!res.success) return null;
  const raw = (res.data as { providers?: unknown } | undefined)?.providers;
  if (!Array.isArray(raw)) return [];
  const providers: OmpLoginProvider[] = [];
  for (const entry of raw) {
   const candidate = entry as { id?: unknown; authenticated?: unknown } | null;
   if (candidate && typeof candidate.id === 'string') {
    providers.push({ id: candidate.id, authenticated: candidate.authenticated === true });
   }
  }
  return providers;
 } catch {
  return null;
 }
}

/**
 * Spins up a scratch, non-Session `OmpProcess` (temp-dir cwd, started on demand, stopped and the
 * temp dir removed when done) purely to call `requestLoginProviders` above, for a caller with no
 * already-running process of its own to reuse.
 *
 * This is the one place this scratch probe is built: `ipc/accounts.ts`'s `ACCOUNTS_OMP_LIST`
 * handler calls this (it never has a live `OmpProcess` to reuse); `readiness.ts`'s sign-in
 * failure hint calls `requestLoginProviders` directly on its own probe process when that process
 * is still usable, and falls back to this only when it is not (GateCode008 MEDIUM "the scratch-OMP
 * provider probe is duplicated" / "the sign-in failure hint spins up a second scratch omp").
 *
 * Never rejects: `mkdtemp` and the `OmpProcess` construction live inside the `try` here (a
 * failure there resolves to the documented failure value instead of rejecting the caller's
 * `invoke`).
 */
export async function readOmpLoginProviders(sessionId: string): Promise<OmpLoginProvider[] | null> {
 try {
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'refract-omp-login-providers-'));
  const proc = new OmpProcess({ cwd: scratchDir, approvalMode: 'ask', sessionId, noSession: true, readyPromptAfterMs: PROBE_READY_PROMPT_AFTER_MS, readyCeilingMs: PROBE_READY_CEILING_MS, startDeadlineMs: PROBE_START_DEADLINE_MS, deferForMemory: false });
  try {
   await proc.start();
   return await requestLoginProviders(proc);
  } finally {
   await proc.stop().catch(() => undefined);
   await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
 } catch {
  return null;
 }
}
