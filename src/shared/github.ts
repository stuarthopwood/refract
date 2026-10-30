// Nothing here is persisted to disk -- every shape is fetched live from GitHub through `gh` and
// held only in main-process memory, keyed by `(repositoryId, number)`, for the lifetime of a detail
// view and for the staleness check.

/** Never carries an avatar image (research.md decision 9); the renderer shows `name` when present, else `login`. */
export interface PullRequestActor {
  login: string;
  name: string | null;
  kind: 'user' | 'bot';
  avatarUrl: string | null; // shown only after the main-process image proxy (ADR 0004)
}

export type CheckOutcome = 'action-required' | 'failing' | 'pending' | 'successful' | 'neutral' | 'skipped';

/** One entry of the status check rollup. */
export interface PullRequestCheck {
  name: string;
  outcome: CheckOutcome;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
}

export type PullRequestState = 'open' | 'draft' | 'closed' | 'merged';
export type CheckState = 'pending' | 'passed' | 'failed';

/** `checkState` is the same three-state value `PullRequestDetail` uses, plus `'none'` when the pull request has no checks at all -- a row never implies a status by colour alone. */
export interface PullRequestSummary {
  number: number;
  title: string;
  state: PullRequestState;
  checkState: CheckState | 'none';
  repository: string; // "owner/repo", for the row's Repository column
  updatedAt: string; // ISO 8601; feeds the row's "time since last updated"
  author: PullRequestActor;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** `patch === null` is the per-file truncation signal; it never means "no changes" (an untouched-but-listed file can't occur -- `gh` only lists files that actually changed). */
export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null; // null = too large to show in full (FR-011)
}

/** `view.mergeable`'s three real states (`gh pr view --json mergeable` is a string enum, never just a boolean): `'unknown'` means GitHub is still computing mergeability in the background, not that the pull request has conflicts -- it gets its own "still checking" treatment rather than being folded into "not mergeable". */
export type MergeableState = 'mergeable' | 'conflicting' | 'unknown';

/** The Overview tab's content plus everything the detail view's header actions need to decide what's offered. */
export interface PullRequestDetail {
  number: number;
  title: string;
  state: PullRequestState;
  baseBranch: string;
  headBranch: string;
  author: PullRequestActor;
  reviewers: PullRequestActor[];
  assignees: PullRequestActor[];
  labels: string[];
  description: string; // markdown; rendered through Markdown.tsx, never raw HTML (FR-023)
  timeline: TimelineEntry[];
  checkState: CheckState | 'none';
  checks: PullRequestCheck[];
  viewerLogin: string | null; // the signed-in gh user
  mergeableState: MergeableState;
  reviewDisabledReason: string | null; // e.g. "This pull request is a draft."; null when Review/
  mergeDisabledReason: string | null; // adds "This pull request has merge conflicts.", a blocked
  // state's own reason, etc. on top of reviewDisabledReason; null when Merge is available
  allowedMergeMethods: MergeMethod[]; // only the methods this repository allows for this pull request
  additions: number;
  deletions: number;
  changedFilesCount: number;
  // The Changes tab's own per-file data: contracts/ipc.md names no separate request for this, so
  // `detail` is the one transport for it, alongside everything else this tab needs.
  files: ChangedFile[];
  // The real GitHub URL (for "Open in browser"): computed by main (which
  // already resolves owner/repo for every `gh` call) so the renderer never needs its own owner/repo
  // parsing just to build this one link.
  url: string;
  updatedAt: string; // staleness marker (FR-021), compared on every mutating request
  headSha: string; // staleness marker (FR-021); a force-push changes this even if updatedAt lags
  // Security remediation (Medium-but-must-fix): true for a fork pull request -- "New session" shows
  // an untrusted-code warning (prompt-injection/AGENTS.md risk from an unknown author) before
  // checking out and running an agent against this branch.
  isFork: boolean;
  headRepositoryOwner: string | null;
}

export type ReviewVerdict = 'comment' | 'approve' | 'request-changes' | 'dismissed';

export interface AutomatedFinding {
  severity: 'low' | 'medium' | 'high' | 'critical' | 'unknown'; // research.md decision 4
  body: string; // markdown; rendered through Markdown.tsx
  path: string | null; // file the finding is anchored to, when known
  line: number | null;
}

export interface Review {
  id: string;
  author: PullRequestActor;
  verdict: ReviewVerdict;
  body: string; // markdown
  submittedAt: string;
  edited: boolean;
  findings: AutomatedFinding[];
}

/** `comments[0]` is the thread's opening comment; `replyToThread` adds to the end of this array and is itself a GraphQL reply-to-the-first-comment mutation (research.md decision 3), never a new, unrelated top-level comment. */
export interface ReviewComment {
  id: string;
  author: PullRequestActor;
  body: string; // markdown
  createdAt: string;
  edited: boolean;
}

/** A review thread anchored to a diff location, with a resolved/unresolved state. */
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  diffSide: 'left' | 'right';
  resolved: boolean;
  comments: ReviewComment[];
}

/** Modelled as a discriminated union so the renderer can switch on `kind` exhaustively (`Timeline.tsx` renders one row component per kind). */
export type TimelineEntry =
  | { kind: 'commit'; sha: string; message: string; author: PullRequestActor; committedAt: string }
  | { kind: 'comment'; id: string; author: PullRequestActor; body: string; createdAt: string; edited: boolean }
  | { kind: 'review'; review: Review }
  | { kind: 'review-thread'; thread: ReviewThread };

/** The five Filter tabs, in the order the list shows them -- `'all'` (every pull request in the Project, decided 2026-10-16 renaming the old 'open' tab) plus the four relation tabs. */
export type FilterTab = 'all' | 'authored' | 'assigned' | 'involves' | 'review-requested';

/** Issue #499 (2026-10-16 decision): the State control narrowing whichever Filter tab is active, default `'open'`. */
export type PullRequestStateFilter = 'open' | 'closed' | 'all';
