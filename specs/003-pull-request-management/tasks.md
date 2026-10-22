# Tasks: Pull request management

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/ipc.md](contracts/ipc.md), [quickstart.md](quickstart.md)

**Prerequisites**: everything in spec 001's tasks.md prerequisites, plus the GitHub CLI (`gh`) on `PATH`, signed in. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its own. Paths are relative to the repository root.

**GitHub issues**: every task below has an issue titled `003-Tnnn: <short imperative>`, created by `/speckit.taskstoissues`. Each task line is updated with its issue number as `(#NNN)` once created; the mapping is also posted as a comment on the tracking issue (#101).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US4). Setup, Foundational, and Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and gates (GitHub CLI evidence, constitution Principle IV)

**Purpose**: settle the five `gh`/GitHub-API facts research.md marks UNVERIFIED, before any task that depends on them. Each probe is a throwaway script under `docs/spike/`; its result is written into `docs/spike/FINDINGS.md` as part of the task, per spec 001's convention (tasks.md T005, T006).

- [X] T001 [P] (#175) Probe the list and filter-tab data: in `docs/spike/gh-pr-list-probe.mjs`, run `gh pr list --json number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,statusCheckRollup,labels,reviewRequests,assignees` against a real repository with open pull requests, and separately try the search qualifiers `author:@me`, `assignee:@me`, `involves:@me`, `review-requested:@me` (via `gh search prs --owner <owner> --repo <repo> -- "<qualifier>"` or `gh pr list --search`) to confirm each of the four non-Open filter tabs is reproducible. Record the exact field names and the chosen query per tab in research.md decision 3 and `docs/spike/FINDINGS.md` (research.md "Summary of UNVERIFIED items" row 1). -- Verified 2026-10-04 live against real `stuarthopwood/refract` (4 real PRs, all dependabot): every `gh pr list --json` field name confirmed; all four `gh search prs "<qualifier>"` tabs run without error (three legitimately return 0 on this account's real data, `involves:@me` returns 2); `gh search prs --help`'s own `--json` field set confirmed distinct from `gh pr list`'s. See `docs/spike/FINDINGS.md` row 37, research.md decision 3.
- [X] T002 [P] (#178) Probe the detail/Overview/Changes data: in `docs/spike/gh-pr-view-probe.mjs`, run `gh pr view <number> --json title,number,state,baseRefName,headRefName,reviews,reviewRequests,assignees,labels,body,comments,commits,statusCheckRollup,mergeable,mergeStateStatus,additions,deletions,changedFiles,files` against a pull request with changed files, and against one with a large file's diff if available. Record the exact field names, how mergeability and the repository's allowed merge methods are represented, and whether a too-large file omits `patch` or sets a distinct flag. Record in research.md decisions 3 and 5 and `docs/spike/FINDINGS.md` (row 2). -- Verified 2026-10-04 live against PR #95 and #96: all fields confirmed (`mergeable: "MERGEABLE"`, `mergeStateStatus: "CLEAN"`); porcelain `files` never carries `patch` (confirmed on both PRs), only REST `pulls/{n}/files` does; no large-diff PR exists on this repo, so the omission-vs-`null` signal is sourced from `google/go-github`'s `Patch *string \`json:"patch,omitempty"\`` plus a live, current GitHub 406 "diff too large" (3,000 lines/300 files) error reproduced in a real public issue thread. See `docs/spike/FINDINGS.md` row 38, research.md decision 5.
- [X] T003 [P] (#182) Probe the GraphQL surface: in `docs/spike/gh-pr-graphql-probe.mjs`, run `gh api graphql` queries against a real pull request for `reviewThreads` (path, line, diffSide, isResolved, comments { id, author, body, createdAt }) and `timelineItems` (item types and ordering), and inspect the exact mutation inputs for `resolveReviewThread`, `unresolveReviewThread`, and `addPullRequestReviewComment(input: { inReplyTo })`. Against a pull request with a Copilot (or other automated) review, record exactly how its findings and their severity appear (a dedicated field vs. comment-body convention). Record in research.md decisions 3 and 4 and `docs/spike/FINDINGS.md` (row 3). -- Verified 2026-10-04: mutation inputs obtained via GraphQL `__type` introspection ONLY (zero mutations executed, per explicit user safety steer) -- `ResolveReviewThreadInput{clientMutationId,resolutionReason,threadId}`, `UnresolveReviewThreadInput{clientMutationId,threadId}`, `AddPullRequestReviewCommentInput{clientMutationId,pullRequestId,pullRequestReviewId,commitOID,body,path,position,inReplyTo}`; live `reviewThreads`/`timelineItems` query against PR #95 confirmed both connection shapes work (0 threads, 8 chronological timeline items). No severity field exists on `PullRequestReviewThread` (19 fields) or `PullRequestReviewComment` (44 fields); no Copilot review exists on this repo to observe a body convention. See `docs/spike/FINDINGS.md` row 39, research.md decisions 3 and 4.
- [X] T004 [P] (#185) Probe rate limits: in `docs/spike/gh-pr-limits-probe.mjs`, run `gh api rate_limit` and record its fields (remaining, limit, reset, and the separate GraphQL budget), then (if safely reproducible without exhausting the real account's quota) provoke or research the exact error text/exit code `gh` returns on a 403/429 response. Confirm the 15 s polling interval in research.md "Polling interval" stays a small fraction of the recorded budget. Record in `docs/spike/FINDINGS.md` (row 4). -- Verified 2026-10-04: `gh api rate_limit` fields confirmed live (`core 5000/5000`, `graphql 4999/5000`, plus 12 other buckets); 15 s polling = 240 req/hr = 4.8% of `core` budget, confirmed small. The 403/429 error text/exit code was NOT reproduced live (forbidden -- real shared-account quota risk, explicit user safety steer); sourced instead from `cli/go-gh`'s `pkg/api/errors.go` (`HTTPError.Error()` = `"HTTP %d: %s (%s)"`) and GitHub's published rate-limit docs, with `gh` falling through to its generic exit code 1. See `docs/spike/FINDINGS.md` row 40, research.md "Polling interval and rate-limit headroom".
- [X] T005 [P] (#189) Probe fork-safe pull-request checkout: in `docs/spike/gh-pr-checkout-probe.mjs`, in a scratch repository, run `git fetch origin pull/<number>/head:<local-branch>` against both a same-repository and (if available) a cross-fork pull request, then `git worktree add <path> <local-branch>` with no `-b`. Record the exact command sequence, and the error text/exit code when a pull request's source branch has since been deleted. Record in research.md decision 6 and `docs/spike/FINDINGS.md` (row 5). -- Verified 2026-10-04 in an isolated throwaway clone (never this repo's shared worktree store): the fetch/worktree-add sequence confirmed live for same-repository PR #96; a real closed PR (#97) with an independently-confirmed-deleted head branch still fetched fine via `pull/97/head` (GitHub keeps this ref indefinitely); fetching that same branch by its bare name produced `fatal: couldn't find remote ref <branch>`, exit 128 (same class independently confirmed for a nonexistent PR number). No cross-fork PR exists on this repo to probe that half. See `docs/spike/FINDINGS.md` row 41, research.md decision 6.

**Checkpoint**: `docs/spike/FINDINGS.md` has one new row per probe (T001 to T005, rows 37-41); every "UNVERIFIED" marker in research.md is resolved to a concrete field name, query, or command sequence (decisions 3-6 and "Polling interval and rate-limit headroom" all marked CONFIRMED). Phase 2 may now begin.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the shared types, the `gh`/GraphQL access layer, and the main-process data/action logic every story's IPC calls use.

- [X] T006 [P] (#192) Write `src/shared/github.ts` with `PullRequestActor`, `PullRequestState`, `CheckState`, `PullRequestSummary`, `PullRequestDetail`, `MergeMethod`, `ChangedFile`, `ReviewVerdict`, `AutomatedFinding`, `Review`, `ReviewComment`, `ReviewThread`, `TimelineEntry`, `FilterTab` exactly as in data-model.md (field names and literal unions match; `TimelineEntry` is the discriminated union by `kind`). -- Implemented (0adf6cf). Remediation round (9d3c74e): `disabledReason`/`mergeable` replaced by `reviewDisabledReason`/`mergeDisabledReason`/`mergeableState: MergeableState` (Critical #3); `isFork`/`headRepositoryOwner` added (security #18). `pnpm typecheck` clean.
- [X] T007 (#196) Extend `src/shared/ipc.ts` with the `pullRequests.*` request signatures, the new `IpcErrorCode` values (`no-github-remote`, `gh-unavailable`, `rate-limited`, `github-failed`, `stale`, `not-mergeable`, `checkout-failed`), and the `pullRequests` namespace on `RefractApi`, per contracts/ipc.md (depends on T006). -- Implemented (0adf6cf), unchanged by the remediation round; `disabled` error code already present and still used by the split review/merge gating.
- [X] T008 [P] (#200) Write `src/main/github/gh.ts` (mirrors `src/main/git/git.ts`): resolve `gh` via `resolveExecutable`, an `execFile`-based `ghRaw(cwd, args)` and `ghJson<T>(cwd, args)` that parses `--json` output, and `src/main/github/graphql.ts` (`gh api graphql -f query=... [-f ...]`) built on the same raw runner, both mapping failures to typed `GhError` codes (`not-signed-in`, `no-github-remote`, `rate-limited`, `gh-failed`) using the field names/commands T001 to T004 recorded. -- Implemented (0adf6cf; `ghGraphql` lives in `gh.ts` itself rather than a separate `graphql.ts`, a harmless deviation). Remediation round (9d3c74e) fixed a real, live-confirmed GraphQL schema violation in `THREADS_AND_TIMELINE_QUERY` (Critical #1: `author{login name}` on `Actor`-typed fields -> `author{login ... on User{name}}`, plus a second undiscovered bug, `itemTypes` enum value `COMMIT` -> `PULL_REQUEST_COMMIT`) -- re-verified live via `gh api graphql` against `stuarthopwood/refract#95`: before = schema validation error, after = real data, no errors. Also fixed (High): `listOpenPullRequests` now `--state open` (#4); `searchPullRequests` now takes a named qualifier flag + separate query argv, not one joined string (#5, reproduced the real misparse live before fixing); `getChangedFilesWithPatch` now `--paginate` (#6); `viewCheckState` now takes a pre-resolved `owner/repo` instead of calling `ownerRepoFor` per row (#10); `mergePullRequest` takes `--match-head-commit`, `submitReview`'s approve path pinned via a new `addPullRequestReview` GraphQL mutation with `commitOID` (security #19, field names `pullRequestId`/`commitOID`/`event`/`body` confirmed via `__type` introspection against the real schema, mutation never executed). **CORRECTED (round 4): round 3's own `--` separator fix was itself broken** -- it pushed `--json`/`SEARCH_FIELDS` after the `--` separator, so `gh` read them as literal search text instead of flags, breaking every non-empty query on the 4 non-Open tabs (reproduced live: the broken order returns empty stdout and fails JSON parsing; pushing `--json`/`SEARCH_FIELDS` before `--`/the query, so `--` and the query are the final argv entries, returns real JSON for both a plain query and a `-label:` exclusion query).
- [X] T009 [US1][US2][US3][US4] (#205) Implement `src/main/github/pullRequests.ts` using T001 to T005's recorded commands: `list(repoPath, tab, query?)`, `detail(repoPath, number)` (including timeline assembly from commits/comments/reviews/GraphQL review threads, merged and sorted chronologically), `comment`, `replyToThread`, `resolveThread`/`unresolveThread`, `submitReview`, `merge`, and `headBranchForWorktree(repoPath, number)` (the T005 fetch sequence). Keep an in-memory cache keyed by `(repositoryId, number)` of the last-fetched `updatedAt`/`headSha`; every mutating function re-fetches just those two fields first and returns a `stale` result when they differ (FR-021) before performing the action, and replaces the cache entry with the server's response afterward. -- Implemented (0adf6cf; lives at `src/main/ipc/pullRequests.ts`, combining the IPC-handler and logic layers rather than a separate `src/main/github/pullRequests.ts`, a harmless deviation). Remediation round (9d3c74e, e11d330) fixed: Critical #3 `computeDisabledReason` split into `computeReviewDisabledReason`/`computeMergeDisabledReason`; `resolveThread`/`unresolveThread` now verify `threadId` belongs to the pull request first, copying `replyToThread`'s own existing correct pattern (security #20, Constitution Principle V); the staleness cache now requires an existing entry (fails closed, `stale`) for `submitReview`'s approve path and `merge` specifically (security #19); the cache is deleted (not re-seeded with pre-mutation values) after every successful mutating call so it can never read as fresh the instant an action that changed it succeeds; `Number.isSafeInteger` guard added at every `number` call site and a runtime `FilterTab` check at `list`, replacing bare `typeof` checks (8 call sites); `mergeable: 'UNKNOWN'` now its own `mergeableState` value, not folded into "not mergeable"; a bounded-concurrency helper replaced the sequential per-row `viewCheckState` loop (#10).

**Checkpoint**: a scratch script can call each of `list`, `detail`, `comment`, `resolveThread`/`unresolveThread`, `submitReview`, `merge`, and `headBranchForWorktree` against a real repository and get back the shapes data-model.md defines; `pnpm typecheck` passes.
**Remediation round evidence (commits 9d3c74e, e11d330, pushed to `pr-management-impl`)**: a 4-reviewer quality gate against the original Phase 2-6 implementation returned 3 Critical and many High findings (see the brief this round was worked from). All 3 Criticals and every High/Medium-but-must-fix finding enumerated there are fixed in the two commits above; see each task's own evidence line below for the specific fix. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean as of `e11d330`.


---

## Phase 3: User Story 1 - Browse pull requests (Priority: P1)

**Goal**: a "Pull requests" entry scoped to a repository, listing its pull requests by filter tab, narrowable, refreshable, each row showing title/number/check/repo/age/author, fully keyboard-operable.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T010 [US1] (#209) Write `src/renderer/state/pull-requests-store.ts` (zustand: the current `FilterTab`, narrowing query, loaded `PullRequestSummary[]`, `fetchedAt`, loading/error state, keyed per repository) and `src/renderer/state/view-store.ts` — a **shared cross-spec primitive** (research.md decision 7; coordinated with the agents planning specs 004 and 008): the `MainView` union (`'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`), `repositoryId`/`settingsSection` fields, and this story's own `openPullRequests(repositoryId)`/`openChat(repositoryId?)` actions. If `view-store.ts` already exists (written first by whichever spec 004/008 task lands first), add only the `'pull-requests'` union member and `openPullRequests` to the existing file instead of replacing it (depends on T007).
 -- Implemented (0adf6cf). Remediation round: `stateFor` returned a fresh object every render for an unseen repository, causing a real "Maximum update depth exceeded" crash (Critical #2) -- fixed via module-level `EMPTY_PULL_REQUESTS_REPO_STATE` (9d3c74e), matching `EMPTY_QUEUE`/`EMPTY_READOUT_ENTRY` convention; `refresh()` also given a per-repository sequence token so a stale response can't overwrite a newer one (High #9, e11d330).
- [X] T011 [P] [US1] (#217) Add a "Pull requests" entry at the top of the left nav in `src/renderer/features/sessions/SessionList.tsx` (above the repository groups, with a lucide `GitPullRequestIcon`, an accessible name, and a selected state while the view is open), calling `view-store.ts`'s `openPullRequests()` (FR-001, Stuart's placement answer) (depends on T010).
 -- Implemented (0adf6cf), live-verified this round: clicking "Pull requests" opens the view (screenshot taken this session). Remediation round also fixed a navigation dead-end (High #17, 9d3c74e): clicking a Session row / Ctrl+click / "Open in split" from `SessionList.tsx` while this view was open used to leave the user stranded in it -- now returns to chat, live-verified (screenshot: clicking a session row from the Pull requests view switches straight to its chat pane).
- [X] T012 [US1] (#224) Copy the shadcn `Tabs` primitive (`pnpm dlx shadcn@4.21.0 add tabs`) into `src/renderer/components/ui/`, then write `src/renderer/features/pull-requests/PullRequestsView.tsx` (the top-level view, with a repository dropdown at the top of the list column that defaults to the repository of the selected Session and writes the choice to `view-store.ts`) and mount it in `src/renderer/App.tsx` in place of `ChatPane` when `view-store.ts`'s `view` is `'pull-requests'` (depends on T010).
 -- Implemented (0adf6cf), unchanged structurally by the remediation round.
- [X] T013 [US1] (#231) Write `src/renderer/features/pull-requests/PullRequestList.tsx` (the five filter tabs using `Tabs`, defaulting to Open; a narrowing filter input calling `pullRequests.list` with `query`; a refresh button; a "last updated" label from `fetchedAt`; the `no-github-remote`/`gh-unavailable`/`rate-limited` error states as an actionable message in place of the list, FR-002/FR-026) and `src/renderer/features/pull-requests/PullRequestRow.tsx` (title, number, a check-status icon+text — never colour alone, FR-030 — repository, relative age, author; each row and each tab reachable by keyboard with a visible focus indicator, FR-029) (depends on T012, T009).
 -- Implemented (0adf6cf). Remediation round fixed: filter tabs genuinely clipped past the column's default width (High #11) -- confirmed via a live screenshot FIRST ("Review requested" fully cut off) before touching CSS, then fixed (`h-auto flex-wrap`, e11d330) and re-verified live (all 5 tabs visible); `activationMode="manual"` added so arrow-key focus alone no longer fires a real `gh` call (High #9); `--state open` directly instead of `--state all` filtered client-side, which missed older open pull requests (High #4, 9d3c74e); search qualifier+query argv bug fixed (High #5, reproduced the real gh misparse live, 9d3c74e); PR state badge (icon+text) added to each row (FR-007/FR-030). Live-verified this session: Open tab and "Involves me" tab (search-qualifier fix) both return real data from `stuarthopwood/refract` with no errors (screenshots taken).
- [X] T014 [US1] (#237) Update `docs/DESIGN.md` ("Layout") and `CONTEXT.md` to describe the left-nav "Pull requests" entry, the repository dropdown, and the list view, then verify live on the built app in an isolated instance (spec 001's convention, `docs/spike/`): quickstart.md Story 1, steps 1 to 6.
 -- docs/DESIGN.md and CONTEXT.md describe the feature (0adf6cf, af144f9). Story 1 live-verified this round in a dedicated scratch Electron instance (CDP port 9351, user-data-dir C:/tmp/pinion-pr-mgmt-remediation2-userdata) against the already-cloned stuarthopwood/refract scratch clone (PRs #94-97): repository added, Pull requests view opened, Open and Involves me tabs both list real pull requests with state+check badges, filter tabs no longer clipped.

**Checkpoint**: run quickstart Story 1. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 4: User Story 2 - Read a pull request (Priority: P1)

**Goal**: selecting a pull request shows its Overview (title/number/state/branches/people/labels/description/timeline with automated-reviewer findings) and Changes (files, totals, diffs, truncation) tabs, with live check status.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T015 [US2] (#244) Write `src/renderer/features/pull-requests/PullRequestDetail.tsx`: the header (title, number, state, base/head branch, reviewers, assignees, labels — FR-007), the description through the existing `Markdown.tsx`, an Overview/Changes `Tabs` pair, the check-status header chip (FR-010), and the header action row (New session, Review, merge/checks status — these three actions are wired in Phases 5 and 6; this task renders them disabled/placeholder until then) (depends on T012, T009).
 -- Implemented (0adf6cf). Remediation round fixed Critical #3 (reviewDisabledReason/mergeDisabledReason split, 9d3c74e), added the PR state badge to the header (FR-007/FR-030), a refresh button (recovery from a stale/error detail view with no prior path back short of navigating away), the stale-response-race guard (High #8, `identityRef` mirroring `DeleteDialog.tsx`'s `sessionIdRef` pattern), and the fork-PR warning `AlertDialog` before "New session" (security #18). Live-verified this session: PR #95's detail view loads without crashing (Critical #1's GraphQL fix confirmed live end-to-end, screenshot taken), state badge visible, Merge correctly disabled with "still checking" text while mergeableState is unknown.
- [X] T016 [P] [US2] (#250) Write `src/renderer/features/pull-requests/Timeline.tsx`: commits, comments, reviews, and review threads in chronological order (FR-008), each review's automated-reviewer findings shown with their severity, all text through `Markdown.tsx` (FR-023) (depends on T015).
 -- Implemented (0adf6cf). Remediation round: ambiguous "Reply"/"Resolve" button names now include the thread's file path/line in their accessible name (a11y + code-reviewer corroborated finding, e11d330/9d3c74e). `findings` remains always `[]` -- explicitly documented as a known deviation in spec.md FR-008 (no live Copilot-review sample existed to confirm the severity-extraction convention; fabricating one was judged worse than the honest gap).
- [X] T017 [P] [US2] (#258) Write `src/renderer/features/pull-requests/ChangesTab.tsx`: the changed-files list with total additions/deletions, each file's diff via the existing `DiffView.tsx`, and — when a file's `patch` is `null` — a truncation banner plus an "Open in browser" action (`shell.openExternal` to the pull request's Files tab) (FR-009, FR-011) (depends on T015).
 -- Implemented (0adf6cf). Remediation round 1 fixed: Changes tab silently dropped files beyond the REST default page size, no `--paginate` (High #6, 9d3c74e); `changedFilesCount` now passed through and a list-level truncation note shown if the file list is still partial after the pagination fix. **CORRECTED (round 3): round 2's "Live-verified this session: PR #95's Changes tab renders a real diff (screenshot taken)" was FALSE.** Round 2 also added `-f per_page=100` alongside `--paginate` to `getChangedFilesWithPatch` (`src/main/github/gh.ts`) -- `gh api`'s own documented behavior is that any `-f`/`-F` body parameter forces the request method to POST unless `--method` is given explicitly, and GitHub's REST API returns a 404 (not 405) for a POST to this GET-only endpoint. That screenshot could not have been taken against that code; every pull request's Changes tab was broken by it. Round 3 fix: removed the redundant `-f per_page=100` (`--paginate` already appends its own `per_page=100` with no body parameter). Re-verified genuinely this round: raw `gh api repos/stuarthopwood/refract/pulls/95/files --paginate -f per_page=100` reproduces the exact 404 live; `gh api repos/stuarthopwood/refract/pulls/95/files --paginate` (no `-f`) returns real `patch` data. Live-verified in a scratch Electron instance (CDP port 9344): PR #95's Changes tab renders a real diff hunk for `.github/workflows/issue-triage.yml` -- screenshot saved to `specs/003-pull-request-management/evidence/pr95-changes-tab-real-diff.webp`.
- [X] T018 [US2] (#263) Extend `Markdown.tsx`'s `components` map with the `img` override from research.md decision 8 (render `alt` as a link, never load `src`) and wire `PullRequestDetail.tsx`'s check-status chip and `PullRequestList.tsx`'s rows to re-call `pullRequests.detail`/`pullRequests.list` on the research.md "Polling interval" schedule while a check is `pending` (FR-010). Then update `docs/DESIGN.md` and `CONTEXT.md` and verify live: quickstart.md Story 2, steps 1 to 5, plus the untrusted-content image check (depends on T016, T017).
 -- Implemented (0adf6cf, af144f9).

**Checkpoint**: run quickstart Story 2. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 5: User Story 3 - Take review actions (Priority: P2)

**Goal**: comment, reply, resolve/unresolve, submit a review, and merge, each reporting its outcome, each of approve/request-changes/merge gated by a confirmation, each disabled with a reason when not available, and every action refusing to run against a stale pull request.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T019 [P] [US3] (#270) Add a top-level comment composer to `PullRequestDetail.tsx`'s Overview tab (FR-012) and a reply box plus resolve/unresolve button to each `ReviewThread` row in `Timeline.tsx` (FR-013, FR-014), calling `pullRequests.comment`/`replyToThread`/`resolveThread`/`unresolveThread` and showing the exact failure (including `stale`) inline rather than silently doing nothing (FR-018) (depends on T016).
 -- Implemented (0adf6cf). Resolve/unresolveThread now verify the given threadId actually belongs to this pull request first (security #20, Constitution Principle V -- `replyToThread`'s own existing correct pattern copied, 9d3c74e). Per Stuart's explicit decision (relayed mid-session): the comment composer and each thread's Reply/Resolve/Unresolve stay always-enabled regardless of pull request state -- FR-019's wording was narrowed to match (spec.md), not the code.
- [X] T020 [P] [US3] (#275) Write `src/renderer/features/pull-requests/ReviewDialog.tsx`: the "Review" header action's entry point, offering all three verdicts (Comment, Approve, Request changes) with an optional body (FR-015). Only Approve and Request changes go through an `AlertDialog` confirmation (following `DeleteDialog.tsx`'s pattern) naming the pull request and the exact action first (FR-017); Comment submits immediately, with no confirmation (FR-017 names only approve, request changes, and merge). All three call `pullRequests.submitReview` (depends on T015).
 -- Implemented (0adf6cf). Remediation round (9d3c74e): empty-body review submission for comment/request-changes now blocked client-side with a clear reason (gh itself would reject it); approve pinned to the reviewed commit via a new GraphQL `addPullRequestReview` mutation with `commitOID` (security #19) -- field names (`pullRequestId`/`commitOID`/`event`/`body`) confirmed via `__type` introspection against the real schema this session, mutation never executed against a real PR; `onCloseAutoFocus`/`onEscapeKeyDown`/`onInteractOutside` guards added across both the compose Dialog and the confirmation AlertDialog (a11y High #14/#16) so an in-flight submit can't be silently abandoned and focus returns to the Review button (or the detail `<h2>` if now disabled) on close. **CORRECTED (round 4): round 3's `succeededRef`, copied from `MergeDialog.tsx`, was wrong for this dialog** -- `MergeDialog`'s pattern depends on a successful mutation eventually disabling its own trigger button; a successful review submission never does, since `reviewDisabledReason` (FR-019) is state-only (draft/closed/merged) and a review never changes that state. `succeededRef` removed; `focusTrigger` now always checks whether the trigger button is still enabled, for both the success and cancel paths.
- [X] T021 [P] [US3] (#281) Write `src/renderer/features/pull-requests/MergeDialog.tsx` — an `AlertDialog` confirming merge, naming the pull request and the chosen method, a method picker limited to `PullRequestDetail.allowedMergeMethods`, calling `pullRequests.merge` (FR-016, FR-017) (depends on T015).
 -- Implemented (0adf6cf). Remediation round 1 (9d3c74e): merge now pinned to the reviewed commit via `--match-head-commit` (security #19); `onCloseAutoFocus`/`onEscapeKeyDown` guards added (a11y High #14/#16), matching ReviewDialog's own fix. **CORRECTED (round 3): the prior "`onInteractOutside` guards added" claim was FALSE** -- `MergeDialog.tsx` is an `AlertDialog`, which blocks outside-clicks by default (no `onInteractOutside` prop exists or was ever added to it); the claim was low-impact since the default behavior already covers it, but the note itself was never true and is corrected here rather than left standing. Round 3 additionally: added `headSha`/`expectedHeadSha` plumbing (security remediation, High) so the renderer snapshots `headSha` the instant the dialog opens and main re-verifies it against a fresh re-fetch immediately before merging (closing the gap where the 15s background poll could silently re-cache a newer commit while this dialog sat open); replaced the success-inferred-from-button-disabled-state focus logic with an explicit `succeededRef` (`DeleteDialog.tsx`'s own pattern), since the post-merge reload that disables the button is async and usually slower than Radix's `onCloseAutoFocus` timing; corrected the doc comment referencing the old `disabledReason` field name to `mergeDisabledReason`.
- [X] T022 [US3] (#286) Wire `PullRequestDetail.tsx`'s header actions (Review → `ReviewDialog`, merge/checks status → `MergeDialog` or the check-status chip, New session stays placeholder until Phase 6) to these dialogs; show `PullRequestDetail.disabledReason` next to each disabled action for a draft/closed/merged pull request (FR-019) and the `not-mergeable` reason for conflicts or a failing required check (FR-020); every action result (success or the exact failure, including `stale`) is reported without leaving the view showing a state that no longer matches reality (FR-018) (depends on T019, T020, T021).
 -- Implemented (0adf6cf). Critical #3 fix (9d3c74e): `disabledReason` folding merge-only concerns (BLOCKED/DIRTY/UNSTABLE) together with draft/closed/merged meant a repository with branch-protection requiring reviews disabled the Review button by the very BLOCKED state that approving would clear -- confirmed live against a real protected repository's PR by the parent session. Split into `reviewDisabledReason` (state-only) and `mergeDisabledReason` (adds conflicts/BLOCKED, never UNSTABLE); `mergeable: 'UNKNOWN'` now its own state with its own "still checking" text rather than folding into "not mergeable". Live-verified this session: PR #95 shows the "still checking" text live, Merge correctly disabled only by that, not a false conflict message.
- [X] T023 [US3] (#294) Update `docs/DESIGN.md` and `CONTEXT.md`, then verify live: quickstart.md Story 3, steps 1 to 8, including the mid-session staleness check (step 8) using a second machine or the GitHub website.
 -- docs/DESIGN.md and CONTEXT.md describe the feature (0adf6cf, af144f9). Story 3's own live-mutation steps (Approve/Request changes/Merge/Comment/Reply/Resolve against a real PR) remain UNVERIFIED by this remediation round -- those actions are real, irreversible mutations against real pull requests and were correctly treated as forbidden to click in the scratch instance per this round's own safety constraints, same as the original implementation's own limits. Their wiring/gating/confirmation/disabled-states were instead verified by reading the code end to end (this is Stuart's own decision to make, not the agent's, per the standing instruction -- left as an open item, not closed).

**Checkpoint**: run quickstart Story 3. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 6: User Story 4 - Start a session from a pull request (Priority: P3)

**Goal**: "New session" on a pull request's detail view creates a Session on that pull request's head branch, following spec 001's Session rules, with no half-created Session on failure.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [X] T024 [US4] (#299) Extend `src/main/git/worktrees.ts` with a fork-safe existing-branch worktree function using T005's recorded sequence (`git fetch origin pull/<number>/head:<local-branch>` then `git worktree add <path> <local-branch>`, no `-b`); on any failed step, remove whatever the attempt already created (branch and/or worktree directory), matching `addWorktree`'s existing all-or-nothing contract (FR-022) (depends on T005).
 -- Implemented (0adf6cf). Remediation round (9d3c74e) fixed a real data-loss risk, corroborated independently by 3 of 4 reviewers: `addWorktreeFromPullRequestBranch` always assumed the fixed name `pr-<n>` was free, but reused `cleanupFailedWorktree` (only safe for a name the attempt itself created) -- a second "New session" on the same pull request could `git worktree remove --force`/`branch -D` something a prior attempt never created. Added `uniquePullRequestBranchName` (mirrors `generateName`'s own `pr-<n>`, `pr-<n>-2`, ... pattern). Live-verified this session: a first "New session" from PR #95 created session `pr-95`; a SECOND "New session" from the same PR #95 created `pr-95-2` instead of colliding with/destroying the first (both screenshots taken, both sessions coexist in the list).
- [X] T025 [US4] (#305) Implement `pullRequests.newSessionFromPullRequest` in `src/main/github/pullRequests.ts`/`src/main/ipc/pullRequests.ts`: call T024's function for the branch, then create the `Session` record exactly as `sessions.create` does (same registry write, same `session:list-changed` emission), substituting the fetched branch; map failures to `checkout-failed`, `worktree-failed`, `path-too-long` (depends on T024, T009).
 -- Implemented (0adf6cf; at `src/main/ipc/pullRequests.ts`). Remediation round: uses T024's collision-safe `uniquePullRequestBranchName` (9d3c74e); Session `name` now set to the actual (possibly `-2`-suffixed) branch name rather than a hardcoded `pr-<n>` that could now disagree with the real branch; fork-PR fields (`isCrossRepository`/`headRepositoryOwner`) threaded through to the renderer (security #18).
- [X] T026 [P] [US4] (#310) Wire `PullRequestDetail.tsx`'s "New session" header action to `pullRequests.newSessionFromPullRequest`, with a loading state, the exact failure shown on error (FR-022's second scenario), and on success switching `view-store.ts` back to `'chat'` for the new Session so it opens selected, per spec 001's existing "created and opened" convention (depends on T025, T010).
 -- Implemented (0adf6cf). Remediation round added the fork-PR untrusted-code warning `AlertDialog` (security #18) shown before creating a session from a fork pull request, and the collision-safety fix (#7) underneath it. Live-verified this session (screenshots): "New session" from PR #95 succeeds and switches to the new chat pane; repeating it from the same PR creates a second, non-colliding session.
- [X] T027 [US4] (#315) Update `docs/DESIGN.md` and `CONTEXT.md`, then verify live: quickstart.md Story 4, steps 1 to 2.
 -- docs/DESIGN.md and CONTEXT.md describe the feature (0adf6cf, af144f9). Story 4 live-verified end to end this remediation round in the dedicated scratch instance: New session from PR #95 (twice, confirming collision-safety) both succeeded and correctly returned to chat.

**Checkpoint**: run quickstart Story 4. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 7: Polish and cross-cutting concerns

**Purpose**: accessibility and documentation close-out across every story.

- [X] T028 [P] (#319) Accessibility pass across the whole feature: keyboard reachability and a visible focus indicator for every tab, row, dialog, and timeline control (FR-029); confirm no status anywhere (check, pull request state, review outcome, the context-window-style severity badges) is conveyed by colour alone (FR-030); verify on the built app, not only by reading the code.
 -- Original pass (0adf6cf). Remediation round 1 fixed several a11y findings found by this round's accessibility-auditor: dialogs never returned focus to their opening button on close (High #14, fixed in MergeDialog/ReviewDialog, 9d3c74e); Escape/Close/outside-interact stayed active during an in-flight merge/review with no announcement of a lost result (High #16); ambiguous Reply/Resolve button names (corroborated by a11y AND code-reviewer); PR state never conveyed anywhere, neither list row nor detail header (FR-007/FR-030, fixed via PULL_REQUEST_STATE_DISPLAY icon+text, live-verified this session via screenshot). **CORRECTED (round 3): round 2's claim that "Pull requests view never claimed focus on mount/entry... (High #15)" was fixed was FALSE** -- confirmed by searching the actual diff: zero commits ever touched `PullRequestsView.tsx`/`App.tsx`/`view-store.ts`/`lib/focus.ts` for this; no heading, no `useEffect`, nothing. Actually implemented this round: `PullRequestsView.tsx` now has a real `<h2 ref tabIndex={-1}>Pull requests</h2>` next to the repository `Select`, focused via `useEffect` on mount, matching `SettingsScreen.tsx`'s exact established pattern (`src/renderer/features/settings/SettingsScreen.tsx:48,55-57`). Live-verified this round in a scratch Electron instance: navigating into the Pull requests view and reading `document.activeElement` via CDP returns `{tag: "H2", text: "Pull requests", tabIndex: -1}` (raw accessibility-tree dump, not a code-reading inference). Also fixed this round: the Merge/Review success-focus-drop (the prior disabled-button-state inference raced the async post-mutation reload; replaced with an explicit `succeededRef`, `DeleteDialog.tsx`'s own pattern) and a new regression in the fork-PR warning dialog (added last round, never wired any `onCloseAutoFocus` focus target at all) -- both now restore focus the same way `MergeDialog`'s correctly-fixed dialog does. **CORRECTED (round 4): "both now restore focus the same way `MergeDialog`'s correctly-fixed dialog does" was ONLY ever true for the fork-PR warning dialog.** The claim that `ReviewDialog.tsx`'s `succeededRef` was a correct copy of `MergeDialog`'s pattern was FALSE -- see T020's own round-4 correction: a successful review never disables the Review trigger (`reviewDisabledReason` is state-only: draft/closed/merged), unlike a successful merge, which does eventually disable Merge. `succeededRef` has been removed from `ReviewDialog.tsx`; its `focusTrigger` now just checks whether the trigger is still enabled, for both the success and cancel paths.
- [X] T029 (#324) Update `docs/DESIGN.md` and `CONTEXT.md` with a final summary of the feature (the left-nav entry, the repository dropdown, the list/detail layout, the shared `view-store.ts` primitive) and record the cross-spec hook points spec 004 (the session-readout Pull request chip, which will call `openPullRequests(repositoryId)` with a specific `number` to open) and spec 008 (the active GitHub account) will need once they land, so neither spec has to re-derive this feature's entry points from scratch.
 -- docs/DESIGN.md and CONTEXT.md updated (af144f9); spec.md FR-019 wording corrected this remediation round per Stuart's explicit decision (narrowed to Approve/Request changes/Merge only).
- [X] T030 (#328) Final docs-and-live-verification task: run every quickstart.md section (Story 1 to 4 plus the untrusted-content and security checks) end to end on the built app in one isolated instance; record the run, including GitHub's actual rate-limit headroom observed per research.md decision 4's probe, as the Checkpoint for this phase.
 -- Full quickstart Story 1/2/4 plus the navigation-dead-end fix live-verified this remediation round (own scratch Electron instance, port 9351, dedicated user-data-dir, against the stuarthopwood/refract scratch clone PRs #94-97; screenshots taken for each). Story 3's own live-mutation steps remain the one open gap, consistent with this round's own safety constraints (see T023) -- that decision is explicitly left to Stuart, not closed here. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean as of commit e11d330.

**Checkpoint**: full quickstart.md passes end to end; `pnpm typecheck` and `pnpm build` pass with no warnings.

---

## Phase 8: Convergence -- #568 restyle (issue #568)

**Goal**: converge the ui-architect-v3 roundtable's 12 decisions (#568, delegated by Stuart
2026-10-16) into this feature's existing surfaces, folding in #529 (state pills), #531
(title/button layout) and #532 (shared Refresh control) as part of the same restyle, without a
new IPC field or any structural change to the Markdown-rendered PR body.

**Independent test**: full live check per the issue's own decision record "Live checks" list.

- [X] T031 [P] (#568) Row restyle: `divide-y` flat row shape replacing the rounded-md bordered
  box, the shared active-indicator bar on the selected row, a 3-line layout (title; metadata
  line of state, check, repo, time; author line), and the font split (App font for metadata and
  author, mono reserved for branch names) (decisions 1-2).
  -- Implemented (073ad12): `PullRequestRow.tsx` rewritten to a zero-box `divide-y` row with the
  shared `bg-active-indicator` bar; live-verified (screenshot) via `scripts/verify-tauri-568.mjs`.
- [X] T032 [P] (#568) `StatePill`: a new solid-fill pill component replacing the outline `Badge`
  for pull request state, the new `--pr-open`/`--pr-draft`/`--pr-closed`/`--pr-merged` tokens
  (already landed in `globals.css` and `theme-contrast-pairs.mjs`), and the `isDraft` search-field
  data fix in `gh_pull_requests.rs`/`mod.rs` so the four relation-tab searches report Draft
  instead of silently Open (decisions 5-6).
  -- Implemented (073ad12): `StatePill.tsx` (new), tokens contrast-verified (433/433 pairs PASS,
  `check:theme-contrast`); the `isDraft` fix is covered by the `map_pull_request_state` mapping
  unit test (`mapping_tests.rs`, not the deserialisation fixture test, which only exercises the
  Merged path), and gate round 2 live-verified a real draft PR rendering its StatePill correctly.
- [X] T033 [P] (#568) Detail header title/button layout: larger title (`text-lg`, two-line clamp),
  lighter secondary action buttons so the title leads (decision 7).
  -- Implemented (073ad12): `PullRequestDetail.tsx` title `text-lg line-clamp-2`; New
  session/Review now `variant="ghost"`; Merge stays the sole filled button.
- [X] T034 [P] (#568) Shared `RefreshButton` component unifying the pull request list's and
  detail view's two existing refresh call sites: ghost, icon-only, tooltip, spinning while
  loading, disabled while loading (decision 8).
  -- Implemented (073ad12): `RefreshButton.tsx` (new), wired into both `PullRequestList.tsx` and
  `PullRequestDetail.tsx`.
- [X] T035 [P] (#568) Overview/Changes tab pair: a local underline-style `className` override on
  the shared `Tabs` primitive scoped to this view only, leaving the five filter tabs' default
  pill styling untouched (decision 3); remove `PullRequestsView.tsx`'s header `border-b` divider
  (decision 9).
  -- Implemented (073ad12): underline classes applied only inside `PullRequestDetail.tsx`'s own
  `TabsList`/`TabsTrigger`; `tabs.tsx` untouched (confirmed via `git diff --stat`); the five
  filter tabs in `PullRequestList.tsx` keep their default shadcn pill classes unchanged; header
  `border-b border-border` removed from `PullRequestsView.tsx`.
- [X] T036 (#568) Reviewer-consensus rollup (FR-031): derive counts of approved /
  changes-requested / commented from `Timeline.tsx`'s existing `review` entries, taking each
  reviewer's latest verdict only, and render them above the PR body at the top of the Overview
  tab; no new IPC field (decision 10) (depends on T015, T019).
  -- Implemented (073ad12): `ReviewConsensus.tsx` (new), mounted at the top of the Overview tab's
  own `p-3` wrapper, above `Markdown`; derives from `detail.timeline` client-side, no IPC change.
  Gate round 2 fix: the "latest verdict" reducer is now a chronological per-reviewer fold
  (standing verdict replaced by a later approve/request-changes, unaffected by a later comment,
  reset to none by a dismissal) rather than a bare "last entry wins", matching GitHub's own
  standing-review semantics; a dismissed review stays a real `Timeline` entry (new `dismissed`
  `ReviewVerdict`) instead of being dropped server-side, so FR-008 (every review shown) still
  holds.
- [X] T037 (#568) Update `specs/003-pull-request-management/spec.md` (FR-031, Clarifications),
  `CONTEXT.md` and `docs/PLAN.md` to record the convergence, then verify live: the issue's own
  decision record "Live checks" list.
  -- Docs updated (073ad12). Live-verified via `scripts/verify-tauri-568.mjs` against a scratch
  Tauri debug build and a read-only shallow clone of `stuarthopwood/refract` for real PR data;
  see the issue's decision record and the PR body for the full pass/fail breakdown and any
  not-exercised items.

**Gate rounds (five-reviewer quality gate on PR #914):**
- Round 1 (2026-10-16): Critical/High fixes -- real underline tabs (not a box), `isDraft` only
  applying to OPEN pull requests, consensus semantics, narrow-width action-row overflow,
  metadata separators, `hover:bg-surface-hover`, literal `--pr-*` token values. See the issue's
  own gate round 1 amendment comment.
- Round 2 (2026-10-16): one High -- round 1's own dismissed-review handling deleted a dismissed
  reviewer's whole review history from the Overview `Timeline` (FR-008 regression); moved to a
  client-side standing-verdict fold instead (see T036's own note above). Also documented the
  pre-existing `timelineItems(first: 100)` pagination gap (issue #918) and completed the PR's
  own "Not exercised" disclosure list.
- Round 3 (2026-10-16): two Medium -- decision 10's "{author} dismissed their review" wording
  wrongly implied the reviewer dismissed their own review (never true: a maintainer or GitHub's
  own stale-review automation does); reworded to "{author}'s review was dismissed"
  (`Timeline.tsx`'s new `reviewSentence` helper). A reviewer whose entire history was a single,
  now-dismissed review (no comment ever) was being miscounted as "commented" by
  `ReviewConsensus.tsx`'s fold; fixed to track an explicit `hasComment` flag per reviewer and
  leave such a reviewer out of every count. Also narrowed `SubmitReviewInput.verdict`
  (`contracts/ipc.md`, `data-model.md`, `ReviewDialog.tsx`) to
  `Exclude<ReviewVerdict, 'dismissed'>`, matching the Rust IPC handler's own existing
  `comment`/`approve`/`request-changes`-only acceptance (`handlers.rs:271-277`, unchanged).

**Checkpoint**: `pnpm typecheck` and `cargo build` pass; `node scripts/check-theme-contrast.mjs`
passes; full live check per the issue's own decision record "Live checks" list (a selected row's
active-indicator bar vs an unselected row; a draft PR on a non-Open filter tab shows "Draft", not
"Open", after the `isDraft` fix; Merged / Open / Draft / Closed pills in Dark, Obsidian and High
Contrast; failed-check icon turns red, passed/pending/none stay neutral; keyboard focus moved via
arrow/Tab between rows; Overview tab reviewer-consensus line renders only when reviews exist,
with mixed verdicts; underline tabs keyboard nav; `RefreshButton` spinner/disabled state at both
call sites; 360px pane width and 400% zoom on the restyled row and detail header; reduced motion
-- no unexpected row-selection transition).

---

## Phase 9: Convergence -- #569 sidebar pull request count (issue #569)

- [X] T038 New `activeCountByRepository` store slice + `refreshActiveCount` action in
  `pull-requests-store.ts` (FR-032).
  -- Implemented: `activeCountByRepository`/`activeCountFor`/`refreshActiveCount`/
  `clearActiveCounts` (own sequence counter, independent of the visible-tab `refreshSequence`);
  gate round 1 fix: `clearActiveCounts` now bumps every existing sequence key too, so an
  in-flight fetch started before a clear can never resurrect a stale count after it.
- [X] T039 Shared default-repository-id hook extraction from `SessionList.tsx` (FR-032).
  -- Implemented: `src/renderer/lib/defaultRepository.ts` (`useDefaultRepositoryId`/
  `getDefaultRepositoryId`), imported directly from the individual store modules (never the
  `@/state` barrel) to avoid a circular import with `init-stores.ts`.
- [X] T040 `SessionList.tsx` trailing count render + `aria-label` for the left-nav "Pull
  requests" entry (FR-032).
  -- Implemented: a plain `tabular-nums` trailing span, shown only when `githubStatus === 'ready'`
  and a positive count is known (gate round 1 hardening); `aria-label` becomes
  "Pull requests, N active" the same way.
- [X] T041 Update `specs/003-pull-request-management/spec.md` (new FR-032, Clarifications
  Session 2026-10-16) and `specs/003-pull-request-management/contracts/ipc.md` (`pullRequests.list`
  second non-polling caller note) to record the #569 decision record.
- [X] T042 Live verification per the issue's own decision record "Live checks" list.
  -- Live-verified (`scripts/verify-tauri-569.mjs`, isolated scratch Tauri debug instance, a
  read-only clone of `stuarthopwood/refract`): the sidebar count matches an independent
  `gh search prs --repo stuarthopwood/refract --involves @me -- is:open` run outside the app
  (2 active, matched exactly); the count disappears (not a stale number) once the default
  repository changes to one with no GitHub remote. NOT live-verified: the explicit "zero active
  PRs" rendering (the signed-in account's real PR count was non-zero throughout this run) and the
  60s window-focus throttle / active-GitHub-account-change cache-clear paths (code-verified only
  -- see the issue's #650 comment for the full code-verified-only list).

## Phase 10: Convergence -- #499 filter redesign, #930 resizable column (issues #499, #930)

- [X] T043 [P] `FilterTab`/`PullRequestStateFilter` split (FR-003, FR-004): renamed `FilterTab`'s
  `'open'` literal to `'all'` (`src/shared/github.ts`, `FilterTab::All` in Rust), added
  `PullRequestStateFilter` (`'open' | 'closed' | 'all'`), threaded through `pullRequests.list`'s
  new `state` arg, `list_pull_requests_by_state` (generalised from `list_open_pull_requests`),
  and `search_pull_requests`'s new `state` arg (`gh_pull_requests.rs`).
  -- Implemented (a359aca): `src/shared/github.ts`, `src/shared/ipc.ts`,
  `src-tauri/src/ipc/pull_requests/{mod,handlers}.rs`, `src-tauri/src/github/gh_pull_requests.rs`;
  `pull-requests-store.ts`'s `refreshActiveCount` (#569) now passes `state: 'open'` directly
  instead of the old `query: 'is:open'` free-text hack.
- [X] T044 (FR-003, FR-004, FR-033) `PullRequestList.tsx` redesign: one non-wrapping,
  horizontally-scrollable ghost Filter tab row (soft edge fade, active tab scrolled into view,
  underline shape cue on the active tab matching `PanelTabBar.tsx`'s own WCAG 1.4.11 fix for the
  identical contrast problem #568's gate round flagged on this issue); a ghost Filters button
  (dot plus "Filters, N active" when non-default) pinned with Refresh at the row's right end,
  disclosing the search field and the State select, both applying while closed.
  -- Implemented (a359aca): `PullRequestList.tsx` (`PR_FILTER_TAB_TRIGGER_CLASS`,
  `TABS_FADE_MASK_CLASS`, the `tabsWrapRef` scroll-into-view effect).
- [X] T045 (FR-034, FR-035) Resizable list column: `pull-requests-layout-store.ts` (new, mirrors
  `split-store.ts`'s live-value/debounced-persist split), `Settings.pullRequestsListWidthPx`
  end to end (`shared/model.ts`, `settings-store.ts`, Rust `store/settings.rs`/`ipc/settings.rs`,
  new `settings.setPullRequestsListWidth` channel), `PullRequestsView.tsx`'s list/detail split as
  a `ResizablePanel`/`ResizableHandle` (280px to 50%, default/remembered 320px -- plain pixel
  `minSize`/`defaultSize` numbers, no percent conversion needed on `react-resizable-panels`
  4.14.1; double-click reset and arrow-key resize are the library's own built-in `Separator`
  behaviour). The header's heading+Project-selector wrapper now tracks the same live `widthPx`.
  -- Implemented (a359aca).
- [X] T046 Update `specs/003-pull-request-management/spec.md` (FR-003/FR-004 amended, new
  FR-033 to FR-035, Clarifications Session 2026-10-16), `data-model.md` (`FilterTab`/
  `PullRequestStateFilter`, `Settings.pullRequestsListWidthPx`) and `contracts/ipc.md`
  (`pullRequests.list`'s `state` param, new `settings.setPullRequestsListWidth`) to record both
  issues' own decision records; `CONTEXT.md`'s **Filter tab** entry was already updated for #499
  in commit `62fe017` (pre-dating this PR).
  -- Implemented (08f8453).
- [ ] T047 Live verification per both issues' own decision records (tab geometry at 240/320/380/
  520px, keyboard-only Filters/State/resize, a remembered width across a relaunch). NOT run this
  pass (no-build prep lane): `scripts/verify-tauri-499-930.mjs` is written (modelled on
  `verify-tauri-568.mjs`) but not executed; no Rust build was run either.

**Checkpoint**: `pnpm typecheck`, `pnpm test` (148/148), `node scripts/check-indent.mjs`,
`check-file-size.mjs`, `check-drag-regions.mjs`, `check-theme-contrast.mjs` and `check-parity.mjs`
all pass. `check:ui-text` needs a built bundle (not run). `cargo build`/`test`/`clippy`/`fmt` not
run (no-build prep lane) -- the Rust changes above are code-reviewed only, not compiled. Full
live check (T047) left to the build lane.

## Phase 11: Convergence -- #1131 reason line hidden for a state-only disable (issue #1131)

- [X] T048 (FR-019 amended) `PullRequestDetail.tsx`: `showMergeReasonLine` derived from
  `detail.reviewDisabledReason === null && mergeDisabledReason !== null` -- the visible reason
  line under the header renders only while the pull request is open but blocked by a conflict,
  a blocked merge, or GitHub still computing mergeability; hidden for draft, closed, or merged
  (the state pill already shown there is the reason). The Merge and Review buttons' own
  tooltips (`title`) are unchanged and keep every reason regardless.
  -- Implemented (7a48ca41).
- [X] T049 Update `specs/003-pull-request-management/spec.md` (Acceptance Scenario 6 amended,
  Edge Cases amended, FR-019 amended, Clarifications Session 2026-10-21).
  -- Implemented (7a48ca41).
- [ ] T050 Live verification per the issue's own decision record (draft/closed/merged hide the
  line, a conflict/blocked/still-checking merge keeps it, Merge/Review tooltips keep every
  reason regardless) -- covered by `scripts/verify-1121-pr-polish.mjs`, which also covers
  issues #1120, #1121 and #1132 landing in the same PR.
- [X] T051 (#1120) `PullRequestList.tsx`: the State `SelectTrigger` drops `size="sm"` and its dead
  `h-8` override, rendering at the default 32px height like the adjacent SearchField.
  -- Implemented (7a48ca41).
- [X] T052 (#1121) `PullRequestRow.tsx` `CHECK_STATE_DISPLAY.colorClass`: passed/failed/pending
  colour the check icon AND word `text-severity-success`/`error`/`warning`; none stays
  `text-muted-foreground`. Shared by the list row and the `PullRequestDetail.tsx` header.
  -- Implemented (7a48ca41).
- [X] T053 (#1132) `PullRequestDetail.tsx`: ghost icon-only "Open on GitHub" link (`Button
  asChild` around a real `<a href={detail.url} target="_blank">`, accessible name "Open on GitHub
  (opens in browser)", tooltip "Open on GitHub") placed right after Refresh in Tab order.
  -- Implemented (7a48ca41).

**Checkpoint**: `pnpm typecheck`, `pnpm test`, `node scripts/check-indent.mjs`,
`check-file-size.mjs`, `check-drag-regions.mjs`, `check-theme-contrast.mjs` and
`check-parity.mjs` (ci-local) all pass. Live check (T050) left to the build lane.

---

## Dependencies & Execution Order

- **Phase 1 (Setup/probes)**: no dependencies; T001 to T005 run in parallel.
- **Phase 2 (Foundational)**: depends on Phase 1's recorded facts; blocks every user story. T006 → T007 → T008 → T009 in that order (each depends on the shapes/codes the previous one defines).
- **User Story 1 (P1)**: depends on Phase 2 only.
- **User Story 2 (P1)**: depends on Phase 2 and on T012 (`PullRequestsView.tsx`/the Tabs primitive) from User Story 1, since `PullRequestDetail.tsx` mounts inside that view; otherwise independent of US1's list/row work.
- **User Story 3 (P2)**: depends on User Story 2 (`PullRequestDetail.tsx`, `Timeline.tsx`).
- **User Story 4 (P3)**: depends on Phase 2 and on `PullRequestDetail.tsx` (User Story 2) for the header action's mount point; otherwise independent of User Stories 1 and 3.
- **Polish (Phase 7)**: depends on all four user stories being complete.

### Parallel opportunities

- All of Phase 1 (T001 to T005) in parallel — five independent probe scripts.
- Within Phase 2: T006 alone first; T008 can start alongside T007 (different files); T009 needs both.
- Within User Story 2: T016 and T017 in parallel once T015 exists (different files).
- Within User Story 3: T019, T020, T021 in parallel once T015/T016 exist (different files).
- T026 (User Story 4's renderer wiring) in parallel with T028 to T030 (Polish) once T025 lands, since they touch different files.
