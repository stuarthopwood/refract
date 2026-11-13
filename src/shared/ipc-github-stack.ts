import type { Result } from './ipc';

/** `missing`: no gh-stack extension; `outdated`: older than the supported floor (v0.3.0). */
export type GhStackState = 'ready' | 'missing' | 'outdated';

export interface GithubStackApi {
  /** Probes `gh stack --version`; a gh-level failure (not signed in, no gh) is an error result. */
  state(): Promise<Result<GhStackState>>;
  /** Installs or upgrades the extension, then returns the re-probed state. */
  install(): Promise<Result<GhStackState>>;
}
