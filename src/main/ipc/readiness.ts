// IPC handler for `readiness.*` (contracts/ipc.md "Readiness"): delegates to the real checks in
// `../readiness.ts` (tasks.md T020) and, for `installDependency`, to `../dependencyInstall.ts`
// (spec 006 T014/T015, contracts/ipc.md additions).

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS, IPC_REQUESTS } from '../../shared/ipc';
import type { DependencyInstallProgress, Readiness, Result } from '../../shared/ipc';
import { readinessCheck } from '../readiness';
import { installGit, installGithubCli, installOmp } from '../dependencyInstall';

type InstallableDependency = 'git' | 'omp' | 'github-cli';

const INSTALLABLE_DEPENDENCIES: Record<InstallableDependency, true> = { git: true, omp: true, 'github-cli': true };

// Quality-gate remediation (Medium "no per-dependency lock stops two Install clicks
// overlapping"): module-level, so it is shared across every call this handler ever receives --
// a second `installDependency` call for a dependency already installing returns a busy error
// Result instead of running two installs (and two downloads to two different temp files) for
// the same dependency at once.
const installsInFlight = new Set<InstallableDependency>();

export function registerReadiness(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(IPC_REQUESTS.READINESS_CHECK, async (): Promise<Result<Readiness>> => ({ ok: true, value: await readinessCheck() }));

  // contracts/ipc.md "Readiness": validates the dependency argument, awaits the matching
  // dependencyInstall.ts function while forwarding its progress on readiness:install-progress,
  // and on success re-runs readiness.check() and emits readiness:changed before resolving -- the
  // caller does not need to poll. A thrown install error never leaves the checklist stuck: this
  // handler always resolves (never rejects), reporting dependency-install-failed instead (FR-010).
  ipcMain.handle(IPC_REQUESTS.READINESS_INSTALL_DEPENDENCY, async (_event, dependency: unknown): Promise<Result<void>> => {
    if (typeof dependency !== 'string' || !Object.prototype.hasOwnProperty.call(INSTALLABLE_DEPENDENCIES, dependency)) {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: `${IPC_REQUESTS.READINESS_INSTALL_DEPENDENCY} expects one of 'git' | 'omp' | 'github-cli'` }
      };
    }
    const typedDependency = dependency as InstallableDependency;

    // Quality-gate remediation (Medium): a second call for the same dependency while the first is
    // still running returns a busy error Result (the UI shows this as busy) instead of starting a
    // second concurrent install.
    if (installsInFlight.has(typedDependency)) {
      return { ok: false, error: { code: 'not-idle', message: `An install for '${typedDependency}' is already running.` } };
    }
    installsInFlight.add(typedDependency);

    const onProgress = (progress: DependencyInstallProgress): void => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      try {
        window.webContents.send(IPC_EVENTS.READINESS_INSTALL_PROGRESS, progress);
      } catch (err) {
        console.error('readiness: failed to forward readiness:install-progress', err);
      }
    };

    try {
      switch (typedDependency) {
        case 'git':
          await installGit(onProgress);
          break;
        case 'omp':
          await installOmp(onProgress);
          break;
        case 'github-cli':
          await installGithubCli(onProgress);
          break;
      }
    } catch (err) {
      return { ok: false, error: { code: 'dependency-install-failed', message: err instanceof Error ? err.message : String(err) } };
    } finally {
      installsInFlight.delete(typedDependency);
    }

    const readiness = await readinessCheck();
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      try {
        window.webContents.send(IPC_EVENTS.READINESS_CHANGED, readiness);
      } catch (err) {
        console.error('readiness: failed to broadcast readiness:changed', err);
      }
    }
    return { ok: true, value: undefined };
  });
}
