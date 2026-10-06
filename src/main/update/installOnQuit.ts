// Install-on-quit mechanism (spec 006 FR-015, FR-016, FR-018, research.md decision 5): when a
// verified installer is waiting (`phase: 'downloaded'`) and Refract quits normally, main spawns a
// short-lived helper -- still inside Refract's own kill-on-close Job Object (`process/jobObject.ts`)
// -- whose only job is to hand the real wait-then-install work to a NEW process created through
// WMI (`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`). WMI's own provider host
// (wmiprvse.exe), not this helper, is what actually calls Win32 CreateProcess for that new
// process, and Windows only auto-assigns a freshly-created process to its PARENT's job(s) --
// wmiprvse.exe is never a member of Refract's job, so the wait-then-install process it creates
// is never assigned to it either, and survives Refract's exit intact (quality-gate remediation,
// CRITICAL: `spawn(..., { detached: true })`'s plain `DETACHED_PROCESS`/`CREATE_NEW_PROCESS_GROUP`
// does nothing to escape job membership, so the old helper was being killed by Windows the
// instant Refract's own process exited, before it ever reached `Start-Process ... /S`).
//
// Deliberately NOT done by adding `JOB_OBJECT_LIMIT_BREAKAWAY_OK`/`CREATE_BREAKAWAY_FROM_JOB` to
// the job itself (the other fix the gate report offered): that would let ANY process opt out of
// the job, including a spawned `omp` subprocess, which must stay killable -- that is the whole
// point of `process/jobObject.ts`. The WMI hand-off needs no change to the job's own flags at all
// (smallest blast radius: zero changes to `jobObject.ts`).
//
// Refract does not relaunch itself; the developer's next launch (from the unchanged Desktop/Start
// Menu shortcut) is the new version.
//
// UNVERIFIED: gate T004/T011 pending -- this has not yet been confirmed on a real quit-then-relaunch
// against a packaged build (docs/spike/FINDINGS.md item 12 only verified the job's own
// kill-on-close guarantee, not this WMI breakaway).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePowerShell } from '../process/executables';
import type { UpdateState } from '../../shared/ipc';
import type { UpdateStateStore } from '../store/updateState';

function escapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/** Quality-gate remediation (LOW, security): re-verifies a `'downloaded'` installer immediately
 * before scheduling it, rather than trusting `updateState.json`'s unvalidated, possibly-stale
 * `installerPath` at face value -- the file must still live directly inside `updatesDir`
 * (`<userData>/updates`, never anywhere a caller could have redirected it to) and its SHA-256
 * must still match the `.sha256` sibling file `UpdateInstaller.ts`'s `downloadUpdate` downloaded
 * and verified alongside it and never deletes on success -- that sibling file (not a new
 * `UpdateState` field; the renderer-facing shape of that type is otherwise fixed) is this app's
 * one persisted copy of "the expected hash". */
export async function verifyInstallerBeforeQuit(
  installerPath: string,
  updatesDir: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (path.dirname(installerPath) !== updatesDir) {
    return { ok: false, reason: `installer path ${installerPath} is not directly inside ${updatesDir}` };
  }
  const checksumPath = `${installerPath}.sha256`;
  let expected: string;
  try {
    expected = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  } catch (err) {
    return { ok: false, reason: `could not read ${checksumPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let actual: string;
  try {
    actual = createHash('sha256').update(await fs.readFile(installerPath)).digest('hex');
  } catch (err) {
    return { ok: false, reason: `could not re-hash ${installerPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!expected || actual !== expected) {
    return { ok: false, reason: `${installerPath} no longer matches its published checksum` };
  }
  return { ok: true };
}

/** Spawns the short-lived in-job helper that hands off to a WMI-created, out-of-job
 * wait-then-install process (see file header), and resolves once that hand-off is confirmed
 * (`Win32_Process.Create`'s own `ReturnValue`), not merely once this helper was launched -- a
 * silent hand-off failure must never be mistaken for a scheduled install. The caller persists
 * `phase: 'installing'` only after this resolves successfully. */
export async function scheduleInstallOnQuit(installerPath: string, refractPid: number): Promise<void> {
  const pwsh = await resolvePowerShell();

  // Quality-gate remediation (LOW, security "installer path interpolated into script text"):
  // `$env:REFRACT_INSTALLER_PATH` is left as literal, UNEXPANDED text in this constant -- it is
  // resolved by the WMI-created process from ITS OWN environment (set below via
  // `ProcessStartupInformation.EnvironmentVariables`), never spliced into any script as a string.
  // The installer's filename comes from a GitHub release asset name (less trusted than Refract's
  // own fixed constants), and PowerShell's tokenizer also treats U+2018-U+201B as quote
  // characters, which the previous doubled-ASCII-quote escape alone did not defend against.
  // `refractPid` (a plain integer from `process.pid`, never caller input) and `pwsh` (a
  // `resolveExecutable`/fixed-path-resolved, equally trusted system path) are interpolated
  // directly -- neither is a shell-injection boundary, and `pwsh` is still defensively
  // single-quote-escaped below along with everything else in `innerCommandLine`.
  const innerCommand = `Wait-Process -Id ${refractPid} -ErrorAction SilentlyContinue; Start-Process -FilePath $env:REFRACT_INSTALLER_PATH -ArgumentList '/S'`;
  const innerCommandLine = `"${pwsh}" -NoProfile -NonInteractive -WindowStyle Hidden -Command "${innerCommand}"`;
  const outerScript = [
    `$inner = '${escapeSingleQuoted(innerCommandLine)}'`,
    // Forwards every env var this (outer, in-job) process already has -- including
    // `REFRACT_INSTALLER_PATH`, set below via `spawn`'s own `env` option -- to the WMI-created
    // process. `Win32_ProcessStartup.EnvironmentVariables`, when set at all, REPLACES rather than
    // extends the new process's environment, so this reads the full table rather than listing
    // only the one new variable, to avoid silently dropping `SystemRoot`/`PATH`/etc. the inner
    // `pwsh.exe` itself may need.
    '$envList = [Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }',
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $envList }',
    '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $inner; ProcessStartupInformation = $startup }',
    'if ($result.ReturnValue -ne 0) { Write-Error "Win32_Process.Create failed with ReturnValue $($result.ReturnValue)"; exit 1 }'
  ].join('; ');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', outerScript], {
      windowsHide: true,
      env: { ...process.env, REFRACT_INSTALLER_PATH: installerPath }
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Quality-gate remediation (LOW): an async spawn failure used to have no listener here,
    // which becomes an uncaught 'error' event (a main-process error dialog during quit).
    child.on('error', (err) => {
      reject(err);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`install-on-quit hand-off failed (exit ${code}).${stderr ? ` ${stderr.trim()}` : ''}`));
      }
    });
  });
}

/** Resolves a persisted `'installing'` phase left over from the previous run (FR-018): a version
 * match means the install-on-quit helper succeeded, a mismatch (or the helper never got to run)
 * is reported as a failure rather than ever leaving an unfinished update looking like success.
 * Called once, at startup, before the automatic update check. A `phase` other than `'installing'`
 * is left untouched -- this only ever resolves that one specific leftover state.
 *
 * Quality-gate remediation (LOW "a successful install leaves the old installer on disk"): on a
 * version match, the installer and its `.sha256` sibling (about 146MB together) are deleted --
 * they already did their job and are never needed again. Two individual file deletes, only ever
 * the exact paths this same `state.installerPath` already names, never a directory. */
export async function resolveInstallingState(store: UpdateStateStore, installedVersion: string): Promise<UpdateState> {
  const state = store.get();
  if (state.phase !== 'installing') return state;
  if (state.availableVersion && state.availableVersion === installedVersion) {
    if (state.installerPath) {
      await fs.unlink(state.installerPath).catch(() => undefined);
      await fs.unlink(`${state.installerPath}.sha256`).catch(() => undefined);
    }
    return store.update({ phase: 'idle', installerPath: undefined, lastError: undefined });
  }
  return store.update({
    phase: 'failed',
    lastError: 'The update did not finish installing. The previous version is still running.'
  });
}
