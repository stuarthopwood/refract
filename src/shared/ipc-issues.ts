// The `issues.*` IPC contract (issue #503, spec 049: "Report an issue"), split into its own file
// to keep `ipc.ts` at its file-size baseline (issue #806), same precedent as `ipc-git-changes.ts`.

import type { Result } from './ipc';
import type { Session } from './model';

export interface IssueLabel {
  name: string;
  /** Six hex digits, no `#`. */
  color: string;
  description: string;
}

/** A search hit for the duplicate check. `state` is GitHub's own upper-case value. Every field is
 * untrusted repository text: render it as text, never as markup, and never execute it. */
export interface IssueMatch {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export type IssueTab = 'all' | 'assigned' | 'authored' | 'mentions';
export type IssueStateFilter = 'open' | 'closed' | 'all';

/** One row of the Issues view (issue #504, spec 051). Every text field comes from GitHub and is
 * untrusted: render it as text, never as markup. */
export interface IssueListItem {
  repositoryId: string;
  repositoryName: string;
  /** `owner/repo`, from the Project's own remote. */
  ownerRepo: string;
  number: number;
  title: string;
  /** GitHub's own upper-case value. */
  state: 'OPEN' | 'CLOSED';
  url: string;
  labels: IssueLabel[];
  assignees: string[];
  author: string;
  commentCount: number;
  updatedAt: string;
}

/** A Project whose issues could not be listed; `code` is a `gh` error code (`no-github-remote`,
 * `gh-unavailable`, `rate-limited`, ...). */
export interface IssueSkippedProject {
  repositoryId: string;
  repositoryName: string;
  code: string;
  message: string;
}

export interface IssueListResult {
  issues: IssueListItem[];
  skipped: IssueSkippedProject[];
  fetchedAt: string;
}

/** `issues.view`: the same fields plus the markdown body (untrusted; render through the
 * sanitised markdown path only). */
/** utoSend is true only when the item's author has write access; otherwise the prompt is prefilled with 
otice. */
export interface Kickoff { prompt: string; autoSend: boolean; notice: string | null }
export interface SessionWithKickoff { session: Session; kickoff: Kickoff | null }

export interface IssueDetail {
  ownerRepo: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  labels: IssueLabel[];
  assignees: string[];
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssuesApi {
  /** The repository's own labels (`gh label list`), at most 200. */
  labels(repositoryId: string): Promise<Result<IssueLabel[]>>;
  /** Up to 5 open or closed issues matching `query`; an empty list when `query` is blank. */
  search(repositoryId: string, query: string): Promise<Result<IssueMatch[]>>;
  /** `gh issue create` with the body on stdin. Validated in Rust: title one line up to 256
   * characters, body up to 60,000, up to 20 labels without commas. */
  create(repositoryId: string, title: string, body: string, labels: string[]): Promise<Result<CreatedIssue>>;
  /** Up to 50 issues per Project, newest updated first, across `repositoryIds` (at most 40; two
   * Projects on one remote list once). `labels` are label names matched any-of (empty means no label filter); `query` is free text. */
  list(
    tab: IssueTab,
    state: IssueStateFilter,
    repositoryIds: string[],
    labels: string[],
    query: string,
  ): Promise<Result<IssueListResult>>;
  /** One issue with its body. */
  view(repositoryId: string, number: number): Promise<Result<IssueDetail>>;
  /** Creates the Session on issue-<n>-<slug>; the renderer sends or prefills the kickoff prompt. */
  newSession(repositoryId: string, number: number): Promise<Result<SessionWithKickoff>>;
}
