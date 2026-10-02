# Data Model: Pull request management

Nothing in this feature is persisted to disk — no new file, no new field in `registry.json` or `settings.json`. Every shape below is fetched live from GitHub through `gh` (research.md decisions 1, 3) and held only in main-process memory, keyed by `(repositoryId, number)`, for the lifetime of a detail view and for the FR-021 staleness check. All types live in `src/shared/github.ts` (new) and are consumed by `src/shared/ipc.ts`'s `pullRequests.*` request/response shapes (contracts/ipc.md).

## Entities

### `PullRequestActor`

A person referenced anywhere in a pull request (author, reviewer, assignee, commenter). Never carries an avatar image (research.md decision 9); the renderer shows `name` when present, else `login`.

```ts
export interface PullRequestActor {
  login: string;
  name: string | null;
}
```

### `PullRequestSummary`

One row in the list (FR-005). `checkState` is the same three-state value `PullRequestDetail` uses (below), plus `'none'` when the pull request has no checks at all — a row never implies a status by colour alone (FR-030).

```ts
export type PullRequestState = 'open' | 'draft' | 'closed' | 'merged';
export type CheckState = 'pending' | 'passed' | 'failed';

export interface PullRequestSummary {
  number: number;
  title: string;
  state: PullRequestState;
  checkState: CheckState | 'none';
  repository: string; // "owner/repo", for the row's Repository column
  updatedAt: string; // ISO 8601; feeds the row's "time since last updated"
  author: PullRequestActor;
}
```

### `PullRequestDetail`

The Overview tab's content plus everything the detail view's header actions need to decide what's offered (FR-007, FR-016, FR-019, FR-020). `disabledReason` is the single source of truth for why Review/merge actions are unavailable — the renderer never re-derives it from `state`/`mergeable` itself, so the displayed reason and the actual gate can never disagree (FR-019, FR-020).

```ts
export type MergeMethod = 'merge' | 'squash' | 'rebase';

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
  mergeable: boolean;
  disabledReason: string | null; // e.g. "This pull request is a draft.", "Checks are failing.",
                                  // "This pull request has merge conflicts."; null when every
                                  // review/merge action is available
  allowedMergeMethods: MergeMethod[]; // only the methods this repository allows for this pull request
  additions: number;
  deletions: number;
  changedFilesCount: number;
  updatedAt: string; // staleness marker (FR-021), compared on every mutating request
  headSha: string; // staleness marker (FR-021); a force-push changes this even if updatedAt lags
}
```

### `ChangedFile`

One entry in the Changes tab (FR-009). `patch === null` (or whatever flag T002's probe confirms, research.md decision 5) is the per-file truncation signal; it never means "no changes" (an untouched-but-listed file can't occur — `gh` only lists files that actually changed).

```ts
export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null; // null = too large to show in full (FR-011)
}
```

### `Review`

A reviewer's submitted verdict (FR-015), shown in the timeline. `findings` is non-empty only for an automated reviewer's review (FR-008); a human review's `findings` is always `[]`.

```ts
export type ReviewVerdict = 'comment' | 'approve' | 'request-changes';

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
  findings: AutomatedFinding[];
}
```

### `ReviewThread` and `ReviewComment`

A review thread anchored to a diff location, with a resolved/unresolved state (FR-013, FR-014). `comments[0]` is the thread's opening comment; `replyToThread` adds to the end of this array and is itself a GraphQL reply-to-the-first-comment mutation (research.md decision 3), never a new, unrelated top-level comment.

```ts
export interface ReviewComment {
  id: string;
  author: PullRequestActor;
  body: string; // markdown
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  diffSide: 'left' | 'right';
  resolved: boolean;
  comments: ReviewComment[];
}
```

### `TimelineEntry`

The Overview's ordered timeline (FR-008): commits, general comments, submitted reviews, and review threads, in chronological order. Modelled as a discriminated union so the renderer can switch on `kind` exhaustively (`Timeline.tsx` renders one row component per kind).

```ts
export type TimelineEntry =
  | { kind: 'commit'; sha: string; message: string; author: PullRequestActor; committedAt: string }
  | { kind: 'comment'; id: string; author: PullRequestActor; body: string; createdAt: string }
  | { kind: 'review'; review: Review }
  | { kind: 'review-thread'; thread: ReviewThread };
```

### `FilterTab`

The five list tabs (FR-003), in the order the list shows them.

```ts
export type FilterTab = 'open' | 'authored' | 'assigned' | 'involves' | 'review-requested';
```

## Derived state, not stored types

- **"Last updated" (FR-006)**: a timestamp main attaches to the `list()` response at fetch time (`{ items: PullRequestSummary[]; fetchedAt: string }`), not a field on any pull request itself — it answers "when did Refract last ask GitHub", not "when did this pull request last change".
- **Staleness (FR-021)**: computed by comparing a mutating request's just-fetched `updatedAt`/`headSha` against the cached `PullRequestDetail`'s values; not a stored boolean, because the comparison must happen at the moment of the action, not at the moment the detail was first loaded.
- **Check status updates (FR-010)**: the renderer's polling loop (research.md "Polling interval") simply calls `detail()` again; there is no separate "check event" type, because every poll already returns the full, current `checkState`.

## State transitions

- **`PullRequestState`**: `draft → open → closed` or `draft → open → merged`; `open → closed` without merging is also possible (closed without merge). Refract never transitions this value itself — it only reflects what `gh` reports after any action (merge, or GitHub-side changes outside Refract).
- **`ReviewThread.resolved`**: `false → true` (resolve) and `true → false` (unresolve), both explicit, both reversible (FR-014, US3 AC3). Refract does not infer resolution from anything else (for example, a reply does not implicitly resolve a thread).
- **`CheckState`**: `'pending' → 'passed' | 'failed'`, one-directional once a check finishes for a given commit; a new commit (a new `headSha`) can reset it back to `'pending'` for the new checks, which is exactly why the detail cache's staleness check keys off `headSha` rather than trusting a cached `checkState`.
