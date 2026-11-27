// The `listCache.read` contract (issue #1895, spec 001 FR-181 (b), (c)): the last good default open
// Pull requests and Issues lists, read once at startup so a cold start shows rows before `gh`
// answers. Every text field came from GitHub and is untrusted: render it as text, never as markup.
import type { Result } from './ipc';
import type { IssueListResult } from './ipc-issues';
import type { PullRequestAcrossResult } from './ipc-pull-requests';

/** A list is `null` when nothing usable is cached for it. */
export interface ListCacheSnapshot {
  pullRequests: PullRequestAcrossResult | null;
  issues: IssueListResult | null;
}

export interface ListCacheApi {
  read(): Promise<Result<ListCacheSnapshot>>;
}
