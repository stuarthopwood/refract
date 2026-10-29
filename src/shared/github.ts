// Shared types for pull request management (specs/003-pull-request-management/data-model.md).
// Nothing here is persisted to disk -- every shape is fetched live from GitHub through `gh` and
// held only in main-process memory, keyed by `(repositoryId, number)`, for the lifetime of a
// detail view and for the FR-021 staleness check. Imported by main, preload, and renderer.

/** A person referenced anywhere in a pull request (author, reviewer, assignee, commenter). Never
 * carries an avatar image (research.md decision 9); the renderer shows `name` when present, else
 * `login`. */
export interface PullRequestActor {
  login: string;
  name: string | null;
  kind: 'user' | 'bot';
  avatarUrl: string | null; // shown only after the main-process image proxy (ADR 0004)
}

export type CheckOutcome = 'action-required' | 'failing' | 'pending' | 'successful' | 'neutral' | 'skipped';

/** One entry of the status check rollup (spec 038). */
export interface PullRequestCheck {
  name: string;
  outcome: CheckOutcome;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
}

export type PullRequestState = 'open' | 'draft' | 'closed' | 'merged';
export type CheckState = 'pending' | 'passed' | 'failed';

/** One row in the list (FR-005). `checkState` is the same three-state value `PullRequestDetail`
 * uses, plus `'none'` when the pull request has no checks at all -- a row never implies a status
 * by colour alone (FR-030). */
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

/** One entry in the Changes tab (FR-009). `patch === null` is the per-file truncation signal; it
 * never means "no changes" (an untouched-but-listed file can't occur -- `gh` only lists files
 * that actually changed). */
export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null; // null = too large to show in full (FR-011)
}

/** `view.mergeable`'s three real states (`gh pr view --json mergeable` is a string enum, never
 * just a boolean): `'unknown'` means GitHub is still computing mergeability in the background,
 * not that the pull request has conflicts -- it gets its own "still checking" treatment rather
 * than being folded into "not mergeable". */
export type MergeableState = 'mergeable' | 'conflicting' | 'unknown';

/** The Overview tab's content plus everything the detail view's header actions need to decide
 * what's offered (FR-007, FR-016, FR-019, FR-020). `reviewDisabledReason`/`mergeDisabledReason`
 * are the single source of truth for why Review/merge actions are unavailable -- the renderer
 * never re-derives either from `state`/`mergeableState` itself, so the displayed reason and the
 * actual gate can never disagree (FR-019, FR-020). Split into two reasons (remediation,
 * code-reviewer Critical) because they gate different actions on different conditions:
 * `reviewDisabledReason` is state-only (draft/closed/merged, FR-019); `mergeDisabledReason` adds
 * conflicts and a blocked merge state on top (FR-020), and never folds in `UNSTABLE` (GitHub
 * still allows merging when only non-required checks fail). */
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
  // Approve/Request changes are available (FR-019)
  mergeDisabledReason: string | null; // adds "This pull request has merge conflicts.", a blocked
  // state's own reason, etc. on top of reviewDisabledReason; null when Merge is available (FR-020)
  allowedMergeMethods: MergeMethod[]; // only the methods this repository allows for this pull request
  additions: number;
  deletions: number;
  changedFilesCount: number;
  // The Changes tab's own per-file data (FR-009): contracts/ipc.md names no separate request for
  // this, so `detail()` is the one transport for it, alongside everything else this tab needs.
  files: ChangedFile[];
  // The real GitHub URL (FR-011's "Open in browser" action, FR-025 external links): computed by
  // main (which already resolves owner/repo for every `gh` call) so the renderer never needs its
  // own owner/repo parsing just to build this one link.
  url: string;
  updatedAt: string; // staleness marker (FR-021), compared on every mutating request
  headSha: string; // staleness marker (FR-021); a force-push changes this even if updatedAt lags
  // Security remediation (Medium-but-must-fix): true for a fork pull request -- "New session"
  // shows an untrusted-code warning (prompt-injection/AGENTS.md risk from an unknown author)
  // before checking out and running an agent against this branch.
  isFork: boolean;
  headRepositoryOwner: string | null;
}

export type ReviewVerdict = 'comment' | 'approve' | 'request-changes' | 'dismissed';

/** `findings` is non-empty only for an automated reviewer's review (FR-008); a human review's
 * `findings` is always `[]`. */
export interface AutomatedFinding {
  severity: 'low' | 'medium' | 'high' | 'critical' | 'unknown'; // research.md decision 4
  body: string; // markdown; rendered through Markdown.tsx
  path: string | null; // file the finding is anchored to, when known
  line: number | null;
}

/** A reviewer's submitted verdict (FR-015), shown in the timeline. */
export interface Review {
  id: string;
  author: PullRequestActor;
  verdict: ReviewVerdict;
  body: string; // markdown
  submittedAt: string;
  edited: boolean;
  findings: AutomatedFinding[];
}

/** `comments[0]` is the thread's opening comment; `replyToThread` adds to the end of this array
 * and is itself a GraphQL reply-to-the-first-comment mutation (research.md decision 3), never a
 * new, unrelated top-level comment. */
export interface ReviewComment {
  id: string;
  author: PullRequestActor;
  body: string; // markdown
  createdAt: string;
  edited: boolean;
}

/** A review thread anchored to a diff location, with a resolved/unresolved state (FR-013,
 * FR-014). */
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  diffSide: 'left' | 'right';
  resolved: boolean;
  comments: ReviewComment[];
}

/** The Overview's ordered timeline (FR-008): commits, general comments, submitted reviews, and
 * review threads, in chronological order. Modelled as a discriminated union so the renderer can
 * switch on `kind` exhaustively (`Timeline.tsx` renders one row component per kind). */
export type TimelineEntry =
  | { kind: 'commit'; sha: string; message: string; author: PullRequestActor; committedAt: string }
  | { kind: 'comment'; id: string; author: PullRequestActor; body: string; createdAt: string; edited: boolean }
  | { kind: 'review'; review: Review }
  | { kind: 'review-thread'; thread: ReviewThread };

/** The five Filter tabs (FR-003), in the order the list shows them -- `'all'` (every pull
 * request in the Project, decided 2026-10-16 renaming the old 'open' tab) plus the four
 * relation tabs. Narrowed further by `PullRequestStateFilter`, independent of which tab is
 * active. */
export type FilterTab = 'all' | 'authored' | 'assigned' | 'involves' | 'review-requested';

/** Issue #499 (2026-10-16 decision): the State control narrowing whichever Filter tab is
 * active, default `'open'`. `'closed'` includes Merged (decided 2026-10-07, as on github.com). */
export type PullRequestStateFilter = 'open' | 'closed' | 'all';
