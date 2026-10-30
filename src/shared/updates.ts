// Installer/updates types, split out of `ipc.ts` (over its size cap, #806) and re-exported from there.

export type InstallableDependency = 'git' | 'omp' | 'github-cli';

/** `readiness:install-progress` payload; `restartRequired` means the new binary is only found after a relaunch. */
export interface DependencyInstallProgress {
  dependency: InstallableDependency;
  phase: 'downloading' | 'running' | 'done' | 'failed';
  detail?: string;
  restartRequired?: boolean;
}

/** Update state payload, persisted as `updateState.json`; `installerPath` is stripped before crossing IPC. */
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

// `import type` is erased, so no runtime cycle with `./ipc`.
import type { Check, Readiness, Result, Unsubscribe } from './ipc';

/** `window.refract` members for updates/readiness, merged into `RefractApi` via `extends`. */
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
    /** "Update now": quits, installs the verified download, and relaunches. Needs phase `'downloaded'`. */
    installNow(): Promise<Result<void>>;
  };
  onReadinessInstallProgress(handler: (payload: DependencyInstallProgress) => void): Unsubscribe;
  onReadinessChanged(handler: (payload: Readiness) => void): Unsubscribe;
  onUpdatesStateChanged(handler: (payload: UpdateState) => void): Unsubscribe;
}

// Channel entries stay literal in `ipc.ts`: `scripts/check-parity.mjs` parses its source text and can't follow a spread.
// Module augmentation adds a field to `Readiness` without touching `ipc.ts` (#806).
declare module './ipc' {
  interface Readiness {
    /** Optional; never affects `allPass`. Rust-only check. */
    github?: Check;
  }
}
