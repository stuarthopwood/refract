# Research: Pull request management

Each decision below resolves one open design question or one "NEEDS CLARIFICATION" from plan.md's Technical Context. Items marked **UNVERIFIED** depend on a `gh` CLI or GitHub API fact that has not been checked against this machine's installed `gh` version; each gets a probe task (T001 to T005 in tasks.md) that comes before any task relying on it, recorded in `docs/spike/FINDINGS.md` during implementation, per constitution Principle IV.

## Decisions

### 1. GitHub access: `gh` CLI only, no stored token

- **Decision**: every GitHub read and write shells out to the developer's already-signed-in GitHub CLI (`gh`) from the main process, with `cwd` set to the repository's path so `gh` auto-detects the remote exactly as `gh pr list` does interactively. Refract stores no token, cookie, or credential of its own (FR-027).
- **Rationale**: this is the same stance the constitution already takes for `omp` (Principle I: Refract is a host, not a credential store) and the one spec 008 (profile and accounts) is designed around: "the GitHub CLI does the sign-in... a spike on a Refract-owned GitHub OAuth flow is a separate later task." Building a second, parallel OAuth flow for this spec would contradict that decision before spec 008 lands.
- **Active account, until spec 008 lands**: spec 003's own line says "Access to GitHub is the active GitHub account of the profile menu (spec 008)," but spec 008 is still Draft and its account switcher does not exist in the code yet. Until it does, this feature uses whichever account `gh auth status` reports as currently active — there is exactly one "active" account from `gh`'s own point of view today. When spec 008's `gh auth switch` wiring lands, it changes which account is active before Refract's next `gh` call; this feature needs no change for that to work, because it never caches which account answered a request, only the request's own result.
- **Alternatives considered**: a Refract-owned OAuth device flow (rejected: spec 008 already assigns this to a later, separate spike, and duplicating it here would pre-empt that decision); the Octokit REST/GraphQL client authenticated with a token read from `gh`'s own credential store (rejected: reads a token into Refract's process after all, which is exactly what FR-027 forbids — `gh` must run the request itself, not merely supply a secret for Refract to use directly).

### 2. No separate readiness gate for GitHub

- **Decision**: unlike `git`/`omp`/sign-in (spec 001's blocking readiness checklist), "GitHub access is not available" is handled entirely inside the Pull requests view itself (FR-026), not as a new blocking screen before the app is usable.
- **Rationale**: a developer who never opens a repository's Pull requests view should never be blocked by a GitHub check; spec 001's readiness screen exists because every Session depends on `git` and `omp`, but no Session depends on GitHub. The spec's own wording ("the view MUST show an actionable message instead of an empty or broken list") scopes the failure to the view.

### 3. Porcelain `gh` commands plus `gh api graphql` for what porcelain doesn't expose — **UNVERIFIED exact fields, probes T001 to T003**

- **Decision**: list and view data come from `gh pr list --json <fields>` and `gh pr view <number> --json <fields>` (and `gh search prs` or `--search` queries for the four non-Open filter tabs, per T001). Review-thread resolution state, in-thread replies, and a true chronological timeline come from `gh api graphql` with a hand-written query/mutations (`reviewThreads`, `timelineItems`, `resolveReviewThread`, `unresolveReviewThread`, `addPullRequestReviewComment(input: { inReplyTo: ... })`), because `gh pr view --json` has no field for thread resolution or a unified timeline (T002, T003).
- **Rationale**: `gh`'s porcelain commands cover the common, flat fields (title, state, branches, labels, mergeable, statusCheckRollup) with a stable, documented `--json` surface; the GitHub REST/GraphQL fields this spec also needs (thread resolution, in-reply-to comments, a mixed-type timeline) only exist in the GraphQL schema, and `gh api graphql` is the sanctioned way to reach it without a separate HTTP client or stored token (it rides `gh`'s own authentication).
- **What the probes confirm before Phase 3 to 5 depend on them**:
  - T001 (`docs/spike/gh-pr-list-probe.mjs`): the exact `--json` field names `gh pr list` and `gh search prs`/`--search` return, and which search qualifiers (`author:@me`, `assignee:@me`, `involves:@me`, `review-requested:@me`) reproduce the five filter tabs.
  - T002 (`docs/spike/gh-pr-view-probe.mjs`): the exact `--json` field names for `gh pr view` covering Overview, mergeability (`mergeable`, `mergeStateStatus`), changed files with additions/deletions, and whether a large file's diff omits `patch` or sets a `truncated`-style flag (feeds decision 5).
  - T003 (`docs/spike/gh-pr-graphql-probe.mjs`): the `reviewThreads` connection shape (path, line, diff side, `isResolved`, comment ids), the `timelineItems` connection's item types and ordering, the exact mutation names/inputs for resolve/unresolve/reply, and how an automated reviewer's (Copilot's) findings and their severity actually appear in a real review (a dedicated field, a structured comment body, or something else) — feeds decision 4 and `AutomatedFinding.severity`'s value set (checklist CHK024).
- **Alternatives considered**: calling the GitHub REST/GraphQL API directly with `fetch` and a token read out of `gh`'s credential file (rejected: same FR-027 problem as decision 1 — `gh` itself must be the thing that authenticates, not merely a token source); using only `gh pr view --json` and reconstructing a timeline from its separate `comments`/`reviews`/`commits` arrays without GraphQL (rejected for review threads specifically, because resolution state and in-reply-to linkage are GraphQL-only; accepted as a fallback decision for the timeline items that porcelain *does* cover, see decision shape in data-model.md).

### 4. Automated-reviewer findings and severity — **UNVERIFIED, probe T003**

- **Decision**: `AutomatedFinding.severity` is typed as `'low' | 'medium' | 'high' | 'critical' | 'unknown'`, with `'unknown'` as the safe default when T003's probe cannot locate a structured severity field and the finding is instead parsed out of free-text comment body (for example a Copilot review comment that states its own severity as text). The spec only requires that a finding's severity be shown (FR-008); it does not fix the value set (checklist CHK024), so this is a design-time decision made here, not a spec change.
- **Rationale**: GitHub's Copilot code-review severity is not documented as a stable GraphQL field as of this plan; probing a real Copilot-reviewed pull request is the only way to know whether it is a field or a convention inside the comment body. Shipping an `'unknown'` fallback means the feature degrades to "finding shown, severity unclear" rather than failing to show the finding at all.
- **Alternatives considered**: waiting to ship until the exact field is confirmed (rejected: T003 already schedules the probe before the task that renders findings, so there is no need to block planning on it); inventing a severity from comment-body keyword matching as the primary source rather than a fallback (deferred to the probe's outcome, recorded in `docs/spike/FINDINGS.md`, not decided here).

### 5. Diff and pull-request truncation — **UNVERIFIED exact shape, probe T002**

- **Decision**: `ChangedFile.patch` is `string | null`; `null` (or a `truncated: true` flag, whichever T002 finds) drives the FR-011 banner ("too large to show in full") plus an "Open in browser" action that opens `https://github.com/<owner>/<repo>/pull/<number>/files` (or the file-specific anchor if one exists) via the existing external-link path. The same pattern covers "the whole pull request is too large" from the Edge Cases list: if `gh pr view`'s own output is truncated or errors on an oversized response, the Overview falls back to the fields it does have and shows the same banner.
- **Rationale**: GitHub's API is documented to omit a file's `patch` field once a diff exceeds its size threshold, but the exact signal (`null` field vs. a `BLOB_TOO_LARGE` filetype vs. an explicit `truncated` boolean) is a live API detail worth confirming once rather than guessing twice.
- **Alternatives considered**: calling `gh pr diff --name-only` plus a manual size check before fetching the full diff (rejected as redundant: the `--json` file objects already carry per-file additions/deletions, so a client-side cutoff would duplicate a signal GitHub already reports).

### 6. New session from a pull request: fork-safe branch checkout — **UNVERIFIED, probe T005**

- **Decision**: "New session" fetches the pull request's head branch with `git fetch origin pull/<number>/head:<local-branch>` (this ref form works for both same-repository and fork pull requests, unlike assuming `headRefName` already exists as a local-fetchable branch name) and then runs `git worktree add <path> <local-branch>` — no `-b`, because the branch already exists after the fetch — reusing `src/main/git/worktrees.ts`'s existing failure-cleanup contract: any failed step removes whatever the attempt already created, so no half-created Session is ever left behind (FR-022, mirroring spec 001 T011's `addWorktree` guarantee).
- **Rationale**: a pull request's `headRefName` alone is ambiguous for a fork (the same branch name can exist locally for an unrelated purpose, or the fork's branch may never have been fetched at all); fetching the exact `pull/<number>/head` ref sidesteps both problems and is the same technique `gh pr checkout` itself uses, without requiring a `gh`-authenticated clone each time.
- **What T005 (`docs/spike/gh-pr-checkout-probe.mjs`) confirms**: that `git fetch origin pull/<number>/head:<local-branch>` succeeds against a real GitHub remote for both an in-repository and a cross-fork pull request, and the exact error text/exit code when the pull request's source branch or fork has since been deleted (feeds the `checkout-failed` error code and its user-facing reason, FR-022's second acceptance scenario).
- **Alternatives considered**: `gh pr checkout <number>` directly (rejected: it operates against the *current* checkout, not an isolated worktree path, and would need to run inside the freshly created worktree after the fact in a way that risks a half-created Session if it fails partway — the existing `addWorktree`-style fetch-then-worktree-add sequence keeps the same atomic-cleanup shape every other Session-creation path already has).

### 7. UI placement: no left-nav shell exists yet, and a shared cross-spec `view-store.ts`

- **Decision**: add a "Pull requests" toggle button to the existing per-repository header Refract already renders in `SessionList.tsx` (beside the "new session" and "branch picker" buttons), which calls into `src/renderer/state/view-store.ts` to swap `App.tsx`'s main pane between `ChatPane` and the new `PullRequestsView`, scoped to that repository — see plan.md "Structure Decision" for the full rationale. `view-store.ts` is a single shared primitive, not a file this spec owns alone: coordinating live with the agents planning specs 004 and 008 (both of which also need to swap the main pane — Settings and Manage sessions respectively) produced one agreed shape so three specs don't each invent an incompatible `view-store.ts` and silently clobber each other's file:
  ```ts
  export type MainView = 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'; // this spec adds 'pull-requests'; specs 004/008 add the other two
  interface ViewState {
    view: MainView;
    repositoryId: string | null; // relevant for 'chat' | 'pull-requests' (this spec's scoping)
    settingsSection: SettingsSectionId | null; // spec 004/008's field, unused by this spec
    openChat(repositoryId?: string): void;
    openPullRequests(repositoryId: string): void; // this spec's own action
    openSettings(section?: SettingsSectionId): void; // spec 004/008's action, untouched here
    openManageSessions(): void; // spec 008's action, untouched here
  }
  ```
  This feature only adds the `'pull-requests'` union member and the `openPullRequests` action; it does not implement `openSettings`/`openManageSessions`/`settingsSection`, which are specs 004/008's own scope.
- **Rationale**: specs 004 (Settings access), 007 (themes), and 008 (profile item, account management) are the ones that introduce a persistent left-nav rail; all three are still Draft. Building a left-nav shell as a side effect of this spec would invent that convention ahead of the specs that own it and risk a second, conflicting design once they land. A single shared `view-store.ts` (rather than three parallel per-spec stores with incompatible field names) avoids whichever spec implements first silently overwriting the others' file.
- **Alternatives considered**: waiting to implement this spec until a left nav exists (rejected: Stuart asked for every Draft spec's remaining Spec Kit steps now, and this feature's actual value — browsing and reviewing pull requests — does not depend on where its entry point sits); building a minimal placeholder left-nav rail just for this one entry (rejected: scope creep into specs 004/007/008's territory, and three different "first" left-nav implementations would need reconciling later instead of one); each spec keeping its own independent switch-state store (rejected: `App.tsx` can only render one main pane at a time, so a single source of truth is correct, and the cross-spec coordination above confirms the other two specs agree).

### 8. Markdown images: extend the existing sanitiser, don't build a second one

- **Decision**: pull request text (titles, bodies, comments, automated-reviewer output) renders through the existing `src/renderer/features/chat/Markdown.tsx` component unchanged in its sanitisation pipeline (`react-markdown` + `rehype-sanitize`); its `components` map gains one new entry, `img`, that renders the image's `alt` text as a link to the image's original `src` instead of loading it (FR-024).
- **Rationale**: the constitution (Principle V) and FR-023 already require every surface of untrusted text to go through "the app's sanitiser" — singular. A second markdown renderer for pull requests would be a second place that could drift out of sync with the chat's sanitisation rules.
- **Alternatives considered**: stripping `img` nodes entirely with no fallback (rejected: FR-024 explicitly requires the alt text plus a link, not silent removal).

### 9. Avatars: text/initials only, no image fetch in this spec

- **Decision**: every surface this spec adds (pull request rows, the Overview header's reviewers/assignees/author, timeline entries) shows a person as their display name or, where space is tight, initials — never an avatar image. This spec does not fetch, cache, or render any GitHub avatar.
- **Rationale**: FR-024 forbids loading avatar images into the app window at all; spec 008 ("the main process fetches the GitHub avatar, checks it is a small PNG or JPEG, caches it, and gives the window a local image") is the one spec that builds the fetch-and-cache machinery for avatars, for the profile item. Duplicating a second avatar pipeline here, before spec 008's is designed, would create two implementations of the same main-process image-fetch-and-validate logic.
- **Alternatives considered**: building a local avatar cache now and having spec 008 reuse it later (rejected: spec 008 is a separate, not-yet-planned feature; this plan does not get to design spec 008's data flow on its behalf).

### 10. Confirmations reuse the existing `AlertDialog` pattern

- **Decision**: `ReviewDialog.tsx` (approve / request changes) and `MergeDialog.tsx` (merge, with method picker) are built on the same shadcn `AlertDialog` component `src/renderer/features/sessions/DeleteDialog.tsx` already uses for a destructive confirmation, each naming the pull request and the exact action per FR-017.
- **Rationale**: reusing an existing, already-accessible confirmation pattern (keyboard-operable, visible focus, a named consequence) is both faster and more consistent than introducing a second confirmation primitive; `DeleteDialog.tsx` is the model spec 001 already established for "ask before an action with a real consequence."
- **Alternatives considered**: a plain `Dialog` with custom buttons (rejected: `AlertDialog` is the shadcn primitive specifically intended for "confirm a consequential action," and the project already has one working example to follow instead of inventing a second).

## Polling interval and rate-limit headroom — **UNVERIFIED, probe T004**

- **Decision (pending T004 confirmation)**: the renderer re-calls `pullRequests.detail` every 15 seconds while that pull request's check status is `pending` and its detail view is the one open, and stops polling once checks finish or the view closes; `pullRequests.list` is never polled (FR-006, FR-028).
- **Rationale**: GitHub's authenticated REST rate limit is commonly 5,000 requests/hour per account; a single open detail view polling every 15 s is 240 requests/hour, a small fraction of that budget even before accounting for the GraphQL points budget being separate. T004 (`docs/spike/gh-pr-limits-probe.mjs`) confirms the actual limit this `gh` version reports (`gh api rate_limit`) and the exact error text/exit code `gh` surfaces on a 403/429 "rate limited" response, so the `rate-limited` error code's user-facing message is accurate rather than guessed.
- **Alternatives considered**: a fixed short interval with no cap (rejected: SC-004's "within 2 seconds" is about a *user's own action* reflecting quickly via a fresh fetch after that action, not about continuous fast polling, so a 15 s background interval already satisfies it without wasting rate-limit budget).

## Summary of UNVERIFIED items → probe tasks (tasks.md Phase 1)

| # | Unverified fact | Probe task | Script |
|---|---|---|---|
| 1 | `gh pr list`/`gh search prs` JSON fields and the search qualifiers for the four non-Open filter tabs | T001 | `docs/spike/gh-pr-list-probe.mjs` |
| 2 | `gh pr view` JSON fields for Overview, mergeability, changed files, and the large-diff/truncation signal | T002 | `docs/spike/gh-pr-view-probe.mjs` |
| 3 | GraphQL `reviewThreads`/`timelineItems` shapes, resolve/unresolve/reply mutations, and automated-reviewer finding representation | T003 | `docs/spike/gh-pr-graphql-probe.mjs` |
| 4 | `gh api rate_limit` fields and the exact rate-limited error signal | T004 | `docs/spike/gh-pr-limits-probe.mjs` |
| 5 | Fork-safe pull-request head-branch checkout into a new worktree | T005 | `docs/spike/gh-pr-checkout-probe.mjs` |
