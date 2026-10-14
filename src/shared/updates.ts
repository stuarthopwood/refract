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

// `import type`: fully erased at compile time, so this does not create a runtime circular
// dependency with `./ipc` (which itself imports the three types above from this file).
import type { Check, Readiness, Result, Unsubscribe } from './ipc';

/** `window.refract` members for this spec, merged into `RefractApi` via `extends` (issue #806
 * "No god files": keeps this block, and the channel key objects below, out of `ipc.ts`). */
export interface UpdatesApi {
  readiness: {
    check(): Promise<Result<Readiness>>;
    installDependency(dependency: InstallableDependency): Promise<Result<void>>;
  };
  updates: {
    /** User-initiated; re-checks even from `'failed'`, unlike the automatic startup check. */
    check(): Promise<Result<UpdateState>>;
    getState(): Promise<Result<UpdateState>>;
    /** Downloads and checksum-verifies; `onUpdatesStateChanged` drives a progress indicator. */
    install(): Promise<Result<void>>;
  };
  /** Drives the first-run readiness screen's Install progress text. */
  onReadinessInstallProgress(handler: (payload: DependencyInstallProgress) => void): Unsubscribe;
  onReadinessChanged(handler: (payload: Readiness) => void): Unsubscribe;
  /** Drives the update badge in the status bar. */
  onUpdatesStateChanged(handler: (payload: UpdateState) => void): Unsubscribe;
}

// `IPC_REQUESTS`/`IPC_EVENTS`'s own key-value entries for this spec's channels stay literal and
// inline in `ipc.ts` (not spread from a const here): `scripts/check-parity.mjs` parses that
// object's source text directly, line by line, and has no notion of a spread operator or an
// externally-defined channel-key object.
// Module augmentation (issue #806 "No god files"): adds this field to `Readiness` without
// touching `ipc.ts`'s own interface body -- a plain optional property, pure declaration
// merging, no runtime code.
declare module './ipc' {
  interface Readiness {
    /** Optional (never affects `allPass`, FR-008); Electron's frozen `readiness.ts` never
     * implements this new, Rust-only check (epic #797). */
    github?: Check;
  }
}
