// The `issues.*` IPC contract (issue #503, spec 049: "Report an issue"), split into its own file
// to keep `ipc.ts` at its file-size baseline (issue #806), same precedent as `ipc-git-changes.ts`.

import type { Result } from './ipc';

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

export interface IssuesApi {
  /** The repository's own labels (`gh label list`), at most 200. */
  labels(repositoryId: string): Promise<Result<IssueLabel[]>>;
  /** Up to 5 open or closed issues matching `query`; an empty list when `query` is blank. */
  search(repositoryId: string, query: string): Promise<Result<IssueMatch[]>>;
  /** `gh issue create` with the body on stdin. Validated in Rust: title one line up to 256
   * characters, body up to 60,000, up to 20 labels without commas. */
  create(repositoryId: string, title: string, body: string, labels: string[]): Promise<Result<CreatedIssue>>;
}
