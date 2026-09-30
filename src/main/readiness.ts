// Real readiness checks behind `readiness.check()` (tasks.md T020, contracts/ipc.md
// "Readiness"). Every check is re-run on every call: nothing is cached. No check ever throws;
// a failure is reported as `{ ok: false, hint }`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRaw } from './git/git';
import { OmpProcess } from './omp/OmpProcess';
import type { RpcCommand } from '../shared/frames';
import type { Check, Readiness } from '../shared/ipc';

const execFileAsync = promisify(execFile);

const SUPPORTED_OMP_VERSION = '18.4.4';
const OMP_VERSION_RE = /(\d+\.\d+\.\d+)/;

// contracts/ipc.md "Readiness": the fixed hint shown whenever the sign-in probe cannot confirm
// an authenticated provider, whatever the underlying reason.
const SIGNED_IN_HINT = 'Sign in to OMP: run `omp` once and complete `/login`, then relaunch Pinion.';

async function checkGit(): Promise<Check> {
  const result = await gitRaw(os.tmpdir(), ['--version']);
  if (result.code !== 0) {
    return { ok: false, hint: 'Git not found on PATH. Install Git for Windows and relaunch Pinion.' };
  }
  return { ok: true, found: result.stdout.trim() };
}

async function checkOmp(): Promise<Check> {
  let stdout: string;
  try {
    stdout = (await execFileAsync('omp', ['--version'], { windowsHide: true })).stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, hint: 'omp not found on PATH. Install omp and relaunch Pinion.' };
    }
    return { ok: false, hint: `omp --version failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const found = OMP_VERSION_RE.exec(stdout)?.[1] ?? stdout.trim();
  if (found === SUPPORTED_OMP_VERSION) {
    return { ok: true, found };
  }
  return { ok: false, found, hint: `Expected omp ${SUPPORTED_OMP_VERSION}, found ${found}. Install the supported version and relaunch Pinion.` };
}

// contracts/ipc.md: `ompSignedIn` is ok when `get_login_providers` returns at least one entry
// with `authenticated: true` (docs/spike/signed-in-probe.mjs, FINDINGS item 15). `get_state.model`
// and `get_available_models` are NOT used here: per the contract they are not diagnostic (a
// zero-credential process still resolves a model) or only a corroborating signal.
async function checkOmpSignedIn(): Promise<Check> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinion-readiness-'));
  const proc = new OmpProcess({ cwd: scratchDir, approvalMode: 'ask', sessionId: 'readiness-probe' });
  try {
    await proc.start();
    // `get_login_providers` is not part of the app's normal turn-based command set
    // (src/shared/frames.ts's `RpcCommand` union), so it is not declared there; this readiness
    // probe is the one caller. The cast documents that narrowing, not an actual `any`.
    const res = await proc.request({ type: 'get_login_providers', id: '' } as unknown as RpcCommand);
    if (!res.success) {
      return { ok: false, hint: SIGNED_IN_HINT };
    }
    const providers = (res.data as { providers?: Array<{ authenticated?: boolean }> } | undefined)?.providers ?? [];
    return providers.some((provider) => provider.authenticated === true) ? { ok: true } : { ok: false, hint: SIGNED_IN_HINT };
  } catch {
    return { ok: false, hint: SIGNED_IN_HINT };
  } finally {
    await proc.stop().catch(() => undefined);
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readinessCheck(): Promise<Readiness> {
  const [git, omp, ompSignedIn] = await Promise.all([checkGit(), checkOmp(), checkOmpSignedIn()]);
  return { git, omp, ompSignedIn };
}
