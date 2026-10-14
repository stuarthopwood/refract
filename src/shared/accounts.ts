// Shared types for GitHub/OMP account management (specs/008-profile-and-accounts/data-model.md).
// Split out of `src/shared/ipc.ts` (`AGENTS.md` "No god files", issue #806: that file is already
// over its 600-line baseline and must not grow further) -- re-exported from there so every
// existing `from '../shared/ipc'` import site keeps working unchanged.

/** spec 008 data-model.md: one GitHub CLI account across every signed-in host; never includes
 * a token (FR-012, constitution V). `displayName`/`avatarDataUrl` come from `profileCache.json`,
 * refreshed opportunistically (research.md decision 5) -- both `null` until first fetched, in
 * which case the UI shows `login` and initials respectively. */
export interface GitHubAccount {
  host: string;
  login: string;
  active: boolean;
  state: string;
  /** Why `state` is not 'success', classified in the main process from gh's own per-account error
   * text (never shown raw): the token was rejected, gh could not reach the host, or the cause is
   * unknown. Absent when `state` is 'success'. */
  problem?: 'expired' | 'unreachable' | 'unknown';
  displayName: string | null;
  avatarDataUrl: string | null;
}

/** spec 008 data-model.md, User Story 3: one OMP provider's sign-in state, read live from
 * `get_login_providers` over a scratch management `OmpProcess` -- never persisted (contracts/
 * ipc.md "OMP provider sign-in"), unlike `GitHubAccount`'s cached display fields. */
export interface OmpProviderState {
  id: string;
  authenticated: boolean;
}

/** spec 008 contracts/ipc.md `accounts:github-add-progress`: the add-account flow's one-time
 * code and progress (FR-009), pushed until the flow completes, is cancelled, or fails. */
export interface GitHubAddFlowProgress {
  flowId: string;
  code: string;
  status: 'waiting' | 'completed' | 'cancelled' | 'failed';
  detail?: string;
}
