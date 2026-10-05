import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcCommand } from '../../shared/frames';
import { OmpProcess } from './OmpProcess';

export interface OmpLoginProvider {
 id: string;
 authenticated: boolean;
}

/**
 * Spins up a scratch, non-Session `OmpProcess` (temp-dir cwd, started on demand, stopped and the
 * temp dir removed when done) purely to call the read-only `get_login_providers` command
 * (research.md decision 6, FINDINGS item 15), and returns the provider list.
 *
 * This is the one place this probe is built: `ipc/accounts.ts`'s `ACCOUNTS_OMP_LIST` handler and
 * `readiness.ts`'s sign-in failure hint both had their own copy of this exact construction
 * (GateCode008 MEDIUM "the scratch-OMP provider probe is duplicated") -- both now call this.
 *
 * Never rejects: `mkdtemp` and the `OmpProcess` construction live inside the `try` here (they
 * did not in either previous copy, so a failure there rejected the caller's `invoke` instead of
 * resolving to the documented failure value); any failure -- spawn, request, malformed
 * response -- resolves to `null` instead. Each provider's `id` is validated as a string before
 * being trusted (GateCode008 LOW: the raw RPC response is otherwise untyped).
 */
export async function readOmpLoginProviders(sessionId: string): Promise<OmpLoginProvider[] | null> {
 try {
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'refract-omp-login-providers-'));
  const proc = new OmpProcess({ cwd: scratchDir, approvalMode: 'ask', sessionId, noSession: true });
  try {
   await proc.start();
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
  } finally {
   await proc.stop().catch(() => undefined);
   await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
 } catch {
  return null;
 }
}
