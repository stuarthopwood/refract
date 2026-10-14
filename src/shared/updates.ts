// Shared types for spec 006 ("Installer and updates"), re-scoped onto the Tauri bundler (lane
// R11b, issue #794, epic #797). Split out of `src/shared/ipc.ts` (`AGENTS.md` "No god files",
// issue #806: that file is already over its 600-line baseline and must not grow further) --
// re-exported from there (`export type { ... } from './updates'`) so every existing import site
// (`from '../shared/ipc'`) keeps working unchanged.

export type InstallableDependency = 'git' | 'omp' | 'github-cli';

/** `readiness:install-progress` event payload (data-model.md "DependencyInstallProgress"): one
 * event per step of a dependency Install action (FR-006, FR-010). `restartRequired`: set on a
 * `'done'` install whose just-installed binary could not be found yet at its own known fixed
 * path (no in-process PATH refresh happened), so the checklist row still shows "found" only
 * after Refract is relaunched. */
export interface DependencyInstallProgress {
  dependency: InstallableDependency;
  phase: 'downloading' | 'running' | 'done' | 'failed';
  detail?: string;
  restartRequired?: boolean;
}

/** `updates.check()`/`updates.getState()`/`updates:state-changed` payload (data-model.md
 * "UpdateState"), persisted as `updateState.json`. `installerPath` is main-only: every
 * renderer-facing copy of this type has it stripped before it ever crosses the IPC boundary
 * (plan.md "never a ... file path"). */
export interface UpdateState {
  version: 1;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed';
  availableVersion?: string;
  notesUrl?: string;
  installerPath?: string;
  lastCheckedAt?: string;
  lastError?: string;
  unavailableReason?: 'not-installed' | 'not-signed-in' | 'offline';
}
