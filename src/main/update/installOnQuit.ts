// Install-on-quit mechanism (spec 006 FR-015, FR-016, FR-018, research.md decision 5): when a
// verified installer is waiting (`phase: 'downloaded'`) and Refract quits normally, main spawns a
// small detached, unref'd helper that polls for Refract's own process id to exit, then runs the
// downloaded installer with the standard NSIS silent switch `/S`. Refract does not relaunch
// itself; the developer's next launch (from the unchanged Desktop/Start Menu shortcut) is the
// new version.

import { spawn } from 'node:child_process';
import { resolvePowerShell } from '../process/executables';
import type { UpdateState } from '../../shared/ipc';
import type { UpdateStateStore } from '../store/updateState';

/** Spawns the detached wait-then-install helper and resolves once it has been launched (not once
 * it finishes -- it outlives Refract by design). The caller persists `phase: 'installing'`
 * itself, before or after this call (order does not matter: a crash between the two just means a
 * retried next-quit attempt, never a double-install, since the helper only ever runs once the
 * caller's own pid is confirmed exited). */
export async function scheduleInstallOnQuit(installerPath: string, refractPid: number): Promise<void> {
  const pwsh = await resolvePowerShell();
  // `installerPath` is a path Refract itself chose (userData/updates/<asset name from a
  // verified, checksum-matched GitHub Release>), never arbitrary caller input -- not a shell-
  // injection boundary. PowerShell single-quoted literal strings only need an embedded `'`
  // doubled.
  const escapedPath = installerPath.replace(/'/g, "''");
  const script = `Wait-Process -Id ${refractPid} -ErrorAction SilentlyContinue; Start-Process -FilePath '${escapedPath}' -ArgumentList '/S'`;
  const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

/** Resolves a persisted `'installing'` phase left over from the previous run (FR-018): a version
 * match means the install-on-quit helper succeeded, a mismatch (or the helper never got to run)
 * is reported as a failure rather than ever leaving an unfinished update looking like success.
 * Called once, at startup, before the automatic update check. A `phase` other than `'installing'`
 * is left untouched -- this only ever resolves that one specific leftover state. */
export async function resolveInstallingState(store: UpdateStateStore, installedVersion: string): Promise<UpdateState> {
  const state = store.get();
  if (state.phase !== 'installing') return state;
  if (state.availableVersion && state.availableVersion === installedVersion) {
    return store.update({ phase: 'idle', installerPath: undefined, lastError: undefined });
  }
  return store.update({
    phase: 'failed',
    lastError: 'The update did not finish installing. The previous version is still running.'
  });
}
