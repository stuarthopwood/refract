// The `home.*` IPC contract (issue #869, spec 059: the Home view), in its own file to keep
// `ipc.ts` at its file-size baseline (issue #806), same precedent as `ipc-issues.ts`.

import type { Result } from './ipc';
import type { IssueSkippedProject } from './ipc-issues';

/** `home.lastMessages` reads at most this many Sessions' Conversation tails per call. */
export const HOME_LAST_MESSAGES_MAX = 8;

/** A merged or closed pull request, matched to a Session by `repositoryId` and head `branch` in
 * the renderer. Every text field comes from GitHub and is untrusted: render it as text only. */
export interface ClosedBranchItem {
  repositoryId: string;
  branch: string;
  number: number;
  url: string;
  state: 'MERGED' | 'CLOSED';
}

export interface ClosedBranchesResult {
  items: ClosedBranchItem[];
  /** Projects that could not be listed (`no-github-remote`, `gh-unavailable`, ...). */
  skipped: IssueSkippedProject[];
  fetchedAt: string;
}

export interface HomeApi {
  /** The last user prompt of each Session's current Conversation, one line (at most 160
   * characters), keyed by Session id; `null` when there is none. At most 8 ids. */
  lastMessages(sessionIds: string[]): Promise<Result<Record<string, string | null>>>;
  /** Recently closed or merged pull requests authored by you, per distinct owner/repo across
   * `repositoryIds` (at most 40; Projects with no GitHub remote are reported in `skipped`). */
  closedBranches(repositoryIds: string[]): Promise<Result<ClosedBranchesResult>>;
}
