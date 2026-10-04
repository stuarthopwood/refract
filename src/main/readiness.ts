// Real readiness checks behind `readiness.check()` (tasks.md T020, contracts/ipc.md
// "Readiness"). Every check is re-run on every call: nothing is cached. No check ever throws;
// a failure is reported as `{ ok: false, hint }`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './process/executables';
import { gitRaw } from './git/git';
import { OmpProcess } from './omp/OmpProcess';
import type { RpcCommand } from '../shared/frames';
import type { Check, Readiness } from '../shared/ipc';

const execFileAsync = promisify(execFile);

// contracts/omp-usage.md's version rule: any 18.4.x or 18.5.x patch is supported (FINDINGS
// items 15 and 19 cover 18.4.4 and 18.4.5; item 29 covers 18.5.1, constitution Principle IV);
// only the major and minor-range are pinned.
const OMP_VERSION_SUPPORTED_RE = /^18\.(4|5)\.\d+$/;
const OMP_VERSION_RE = /(\d+\.\d+\.\d+)/;

// contracts/ipc.md "Readiness": the fixed hint shown whenever the sign-in probe cannot confirm
// that OMP's default model is actually usable, whatever the underlying reason.
const SIGNED_IN_HINT = 'Run omp, complete /login, then Re-check.';

async function checkGit(): Promise<Check> {
  const result = await gitRaw(os.tmpdir(), ['--version']);
  if (result.code !== 0) {
    return { ok: false, hint: 'Git not found on PATH. Install Git for Windows and relaunch Refract.' };
  }
  return { ok: true, found: result.stdout.trim() };
}

async function checkOmp(): Promise<Check> {
  let ompPath: string;
  try {
    ompPath = await resolveExecutable('omp');
  } catch {
    return { ok: false, hint: 'omp not found on PATH. Install omp and relaunch Refract.' };
  }
  let stdout: string;
  try {
    stdout = (await execFileAsync(ompPath, ['--version'], { windowsHide: true })).stdout;
  } catch (err) {
    return { ok: false, hint: `omp --version failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const found = OMP_VERSION_RE.exec(stdout)?.[1] ?? stdout.trim();
  if (OMP_VERSION_SUPPORTED_RE.test(found)) {
    return { ok: true, found };
  }
  return { ok: false, found, hint: `Expected omp 18.4.x or 18.5.x, found ${found}. Install a supported version and relaunch Refract.` };
}

// contracts/ipc.md: `ompSignedIn` is ok when `get_state`'s current `model` (provider + id) also
// appears in `get_available_models` (docs/spike/signed-in-probe.mjs, FINDINGS item 15): that
// checks the default model can actually run, not merely that some credential is authenticated.
// `get_login_providers` is used only to enrich the failure hint below.
async function checkOmpSignedIn(): Promise<Check> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'refract-readiness-'));
  // --no-session: this probe never calls `open_session` or any other command requiring
  // persistence (just get_state / get_available_models / get_login_providers), so it never
  // needs a real session-store folder under ~/.omp/agent/sessions (issue #362).
  const proc = new OmpProcess({ cwd: scratchDir, approvalMode: 'ask', sessionId: 'readiness-probe', noSession: true });
  try {
    await proc.start();
    const stateRes = await proc.request({ type: 'get_state', id: '' });
    // `get_available_models` is not part of the app's normal turn-based command set
    // (src/shared/frames.ts's `RpcCommand` union), so it is not declared there; this readiness
    // probe is the one caller. The cast documents that narrowing, not an actual `any`.
    const modelsRes = await proc.request({ type: 'get_available_models', id: '' } as unknown as RpcCommand);
    if (stateRes.success && modelsRes.success) {
      const model = (stateRes.data as { model?: { provider: string; id: string } } | undefined)?.model;
      const models = (modelsRes.data as { models?: Array<{ provider: string; id: string }> } | undefined)?.models ?? [];
      if (model && models.some((m) => m.provider === model.provider && m.id === model.id)) {
        return { ok: true };
      }
    }
    return { ok: false, hint: await signedInFailureHint(proc) };
  } catch {
    return { ok: false, hint: await signedInFailureHint(proc) };
  } finally {
    await proc.stop().catch(() => undefined);
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Enriches SIGNED_IN_HINT with unauthenticated provider ids, when available. This is the one
// remaining use of `get_login_providers`; failures here are swallowed since the base hint is
// already correct without it.
async function signedInFailureHint(proc: OmpProcess): Promise<string> {
  try {
    // `get_login_providers` is not part of the app's normal turn-based command set
    // (src/shared/frames.ts's `RpcCommand` union), so it is not declared there; this is the
    // one caller. The cast documents that narrowing, not an actual `any`.
    const res = await proc.request({ type: 'get_login_providers', id: '' } as unknown as RpcCommand);
    if (res.success) {
      const providers = (res.data as { providers?: Array<{ id: string; authenticated?: boolean }> } | undefined)?.providers ?? [];
      const ids = providers.filter((p) => p.authenticated !== true).map((p) => p.id);
      if (ids.length > 0) {
        return `${SIGNED_IN_HINT} Not signed in: ${ids.slice(0, 5).join(', ')}.`;
      }
    }
  } catch {
    // fall through to the base hint
  }
  return SIGNED_IN_HINT;
}

export async function readinessCheck(): Promise<Readiness> {
  const [git, omp, ompSignedIn] = await Promise.all([checkGit(), checkOmp(), checkOmpSignedIn()]);
  return { git, omp, ompSignedIn };
}
