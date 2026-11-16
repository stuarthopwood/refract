// The cross-Project `pullRequests.listAcross` contract (issue #874, spec 057), in its own file to
// keep `ipc.ts` at its file-size baseline (issue #806), same precedent as `ipc-issues.ts`.

import type { FilterTab, PullRequestStateFilter, PullRequestSummary } from './github';
import type { IssueSkippedProject } from './ipc-issues';
import type { Result } from './ipc';

/** One row of the Pull requests view. Every text field comes from GitHub and is untrusted:
 * render it as text, never as markup. */
export interface PullRequestAcrossItem extends Omit<PullRequestSummary, 'checkState'> {
  repositoryId: string;
  repositoryName: string;
}

export interface PullRequestAcrossResult {
  items: PullRequestAcrossItem[];
  /** True when GitHub has rows beyond `limit`, so "Show more" can ask for more. */
  hasMore: boolean;
  /** Projects that could not be listed (`no-github-remote`, `gh-unavailable`, ...). */
  skipped: IssueSkippedProject[];
  fetchedAt: string;
}

export interface StackRefsResult {
  items: Array<{ number: number; headRef: string; baseRef: string }>;
}

export interface PullRequestsAcrossApi {
  /** Pull requests across `repositoryIds` (at most 40; two Projects on one remote list once),
   * newest updated first, up to `limit` rows (50 to 200). One batched `gh search prs`; the search
   * rate limit is checked first. `query` is free text. */
  listAcross(
    tab: FilterTab,
    state: PullRequestStateFilter,
    repositoryIds: string[],
    query: string,
    limit: number,
  ): Promise<Result<PullRequestAcrossResult>>;
  /** Open pull requests' branch names for one Project, for stack chaining (#1867). */
  stackRefs(repositoryId: string): Promise<Result<StackRefsResult>>;
}
