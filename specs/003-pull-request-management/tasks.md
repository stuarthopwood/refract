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

- [ ] T006 [P] (#192) Write `src/shared/github.ts` with `PullRequestActor`, `PullRequestState`, `CheckState`, `PullRequestSummary`, `PullRequestDetail`, `MergeMethod`, `ChangedFile`, `ReviewVerdict`, `AutomatedFinding`, `Review`, `ReviewComment`, `ReviewThread`, `TimelineEntry`, `FilterTab` exactly as in data-model.md (field names and literal unions match; `TimelineEntry` is the discriminated union by `kind`).
- [ ] T007 (#196) Extend `src/shared/ipc.ts` with the `pullRequests.*` request signatures, the new `IpcErrorCode` values (`no-github-remote`, `gh-unavailable`, `rate-limited`, `github-failed`, `stale`, `not-mergeable`, `checkout-failed`), and the `pullRequests` namespace on `RefractApi`, per contracts/ipc.md (depends on T006).
- [ ] T008 [P] (#200) Write `src/main/github/gh.ts` (mirrors `src/main/git/git.ts`): resolve `gh` via `resolveExecutable`, an `execFile`-based `ghRaw(cwd, args)` and `ghJson<T>(cwd, args)` that parses `--json` output, and `src/main/github/graphql.ts` (`gh api graphql -f query=... [-f ...]`) built on the same raw runner, both mapping failures to typed `GhError` codes (`not-signed-in`, `no-github-remote`, `rate-limited`, `gh-failed`) using the field names/commands T001 to T004 recorded.
- [ ] T009 [US1][US2][US3][US4] (#205) Implement `src/main/github/pullRequests.ts` using T001 to T005's recorded commands: `list(repoPath, tab, query?)`, `detail(repoPath, number)` (including timeline assembly from commits/comments/reviews/GraphQL review threads, merged and sorted chronologically), `comment`, `replyToThread`, `resolveThread`/`unresolveThread`, `submitReview`, `merge`, and `headBranchForWorktree(repoPath, number)` (the T005 fetch sequence). Keep an in-memory cache keyed by `(repositoryId, number)` of the last-fetched `updatedAt`/`headSha`; every mutating function re-fetches just those two fields first and returns a `stale` result when they differ (FR-021) before performing the action, and replaces the cache entry with the server's response afterwards (FR-018). Then write `src/main/ipc/pullRequests.ts` (`registerPullRequests(manager, getWindow)`) wiring every `pullRequests.*` channel to these functions, and wire it into `src/main/ipc/register.ts` (depends on T006, T007, T008).

**Checkpoint**: a scratch script can call each of `list`, `detail`, `comment`, `resolveThread`/`unresolveThread`, `submitReview`, `merge`, and `headBranchForWorktree` against a real repository and get back the shapes data-model.md defines; `pnpm typecheck` passes.

---

## Phase 3: User Story 1 - Browse pull requests (Priority: P1)

**Goal**: a "Pull requests" entry scoped to a repository, listing its pull requests by filter tab, narrowable, refreshable, each row showing title/number/check/repo/age/author, fully keyboard-operable.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [ ] T010 [US1] (#209) Write `src/renderer/state/pull-requests-store.ts` (zustand: the current `FilterTab`, narrowing query, loaded `PullRequestSummary[]`, `fetchedAt`, loading/error state, keyed per repository) and `src/renderer/state/view-store.ts` — a **shared cross-spec primitive** (research.md decision 7; coordinated with the agents planning specs 004 and 008): the `MainView` union (`'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`), `repositoryId`/`settingsSection` fields, and this story's own `openPullRequests(repositoryId)`/`openChat(repositoryId?)` actions. If `view-store.ts` already exists (written first by whichever spec 004/008 task lands first), add only the `'pull-requests'` union member and `openPullRequests` to the existing file instead of replacing it (depends on T007).
- [ ] T011 [P] [US1] (#217) Add a "Pull requests" entry at the top of the left nav in `src/renderer/features/sessions/SessionList.tsx` (above the repository groups, with a lucide `GitPullRequestIcon`, an accessible name, and a selected state while the view is open), calling `view-store.ts`'s `openPullRequests()` (FR-001, Stuart's placement answer) (depends on T010).
- [ ] T012 [US1] (#224) Copy the shadcn `Tabs` primitive (`pnpm dlx shadcn@4.21.0 add tabs`) into `src/renderer/components/ui/`, then write `src/renderer/features/pull-requests/PullRequestsView.tsx` (the top-level view, with a repository dropdown at the top of the list column that defaults to the repository of the selected Session and writes the choice to `view-store.ts`) and mount it in `src/renderer/App.tsx` in place of `ChatPane` when `view-store.ts`'s `view` is `'pull-requests'` (depends on T010).
- [ ] T013 [US1] (#231) Write `src/renderer/features/pull-requests/PullRequestList.tsx` (the five filter tabs using `Tabs`, defaulting to Open; a narrowing filter input calling `pullRequests.list` with `query`; a refresh button; a "last updated" label from `fetchedAt`; the `no-github-remote`/`gh-unavailable`/`rate-limited` error states as an actionable message in place of the list, FR-002/FR-026) and `src/renderer/features/pull-requests/PullRequestRow.tsx` (title, number, a check-status icon+text — never colour alone, FR-030 — repository, relative age, author; each row and each tab reachable by keyboard with a visible focus indicator, FR-029) (depends on T012, T009).
- [ ] T014 [US1] (#237) Update `docs/DESIGN.md` ("Layout") and `CONTEXT.md` to describe the left-nav "Pull requests" entry, the repository dropdown, and the list view, then verify live on the built app in an isolated instance (spec 001's convention, `docs/spike/`): quickstart.md Story 1, steps 1 to 6.

**Checkpoint**: run quickstart Story 1. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 4: User Story 2 - Read a pull request (Priority: P1)

**Goal**: selecting a pull request shows its Overview (title/number/state/branches/people/labels/description/timeline with automated-reviewer findings) and Changes (files, totals, diffs, truncation) tabs, with live check status.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T015 [US2] (#244) Write `src/renderer/features/pull-requests/PullRequestDetail.tsx`: the header (title, number, state, base/head branch, reviewers, assignees, labels — FR-007), the description through the existing `Markdown.tsx`, an Overview/Changes `Tabs` pair, the check-status header chip (FR-010), and the header action row (New session, Review, merge/checks status — these three actions are wired in Phases 5 and 6; this task renders them disabled/placeholder until then) (depends on T012, T009).
- [ ] T016 [P] [US2] (#250) Write `src/renderer/features/pull-requests/Timeline.tsx`: commits, comments, reviews, and review threads in chronological order (FR-008), each review's automated-reviewer findings shown with their severity, all text through `Markdown.tsx` (FR-023) (depends on T015).
- [ ] T017 [P] [US2] (#258) Write `src/renderer/features/pull-requests/ChangesTab.tsx`: the changed-files list with total additions/deletions, each file's diff via the existing `DiffView.tsx`, and — when a file's `patch` is `null` — a truncation banner plus an "Open in browser" action (`shell.openExternal` to the pull request's Files tab) (FR-009, FR-011) (depends on T015).
- [ ] T018 [US2] (#263) Extend `Markdown.tsx`'s `components` map with the `img` override from research.md decision 8 (render `alt` as a link, never load `src`) and wire `PullRequestDetail.tsx`'s check-status chip and `PullRequestList.tsx`'s rows to re-call `pullRequests.detail`/`pullRequests.list` on the research.md "Polling interval" schedule while a check is `pending` (FR-010). Then update `docs/DESIGN.md` and `CONTEXT.md` and verify live: quickstart.md Story 2, steps 1 to 5, plus the untrusted-content image check (depends on T016, T017).

**Checkpoint**: run quickstart Story 2. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 5: User Story 3 - Take review actions (Priority: P2)

**Goal**: comment, reply, resolve/unresolve, submit a review, and merge, each reporting its outcome, each of approve/request-changes/merge gated by a confirmation, each disabled with a reason when not available, and every action refusing to run against a stale pull request.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [ ] T019 [P] [US3] (#270) Add a top-level comment composer to `PullRequestDetail.tsx`'s Overview tab (FR-012) and a reply box plus resolve/unresolve button to each `ReviewThread` row in `Timeline.tsx` (FR-013, FR-014), calling `pullRequests.comment`/`replyToThread`/`resolveThread`/`unresolveThread` and showing the exact failure (including `stale`) inline rather than silently doing nothing (FR-018) (depends on T016).
- [ ] T020 [P] [US3] (#275) Write `src/renderer/features/pull-requests/ReviewDialog.tsx`: the "Review" header action's entry point, offering all three verdicts (Comment, Approve, Request changes) with an optional body (FR-015). Only Approve and Request changes go through an `AlertDialog` confirmation (following `DeleteDialog.tsx`'s pattern) naming the pull request and the exact action first (FR-017); Comment submits immediately, with no confirmation (FR-017 names only approve, request changes, and merge). All three call `pullRequests.submitReview` (depends on T015).
- [ ] T021 [P] [US3] (#281) Write `src/renderer/features/pull-requests/MergeDialog.tsx` — an `AlertDialog` confirming merge, naming the pull request and the chosen method, a method picker limited to `PullRequestDetail.allowedMergeMethods`, calling `pullRequests.merge` (FR-016, FR-017) (depends on T015).
- [ ] T022 [US3] (#286) Wire `PullRequestDetail.tsx`'s header actions (Review → `ReviewDialog`, merge/checks status → `MergeDialog` or the check-status chip, New session stays placeholder until Phase 6) to these dialogs; show `PullRequestDetail.disabledReason` next to each disabled action for a draft/closed/merged pull request (FR-019) and the `not-mergeable` reason for conflicts or a failing required check (FR-020); every action result (success or the exact failure, including `stale`) is reported without leaving the view showing a state that no longer matches reality (FR-018) (depends on T019, T020, T021).
- [ ] T023 [US3] (#294) Update `docs/DESIGN.md` and `CONTEXT.md`, then verify live: quickstart.md Story 3, steps 1 to 8, including the mid-session staleness check (step 8) using a second machine or the GitHub website.

**Checkpoint**: run quickstart Story 3. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 6: User Story 4 - Start a session from a pull request (Priority: P3)

**Goal**: "New session" on a pull request's detail view creates a Session on that pull request's head branch, following spec 001's Session rules, with no half-created Session on failure.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [ ] T024 [US4] (#299) Extend `src/main/git/worktrees.ts` with a fork-safe existing-branch worktree function using T005's recorded sequence (`git fetch origin pull/<number>/head:<local-branch>` then `git worktree add <path> <local-branch>`, no `-b`); on any failed step, remove whatever the attempt already created (branch and/or worktree directory), matching `addWorktree`'s existing all-or-nothing contract (FR-022) (depends on T005).
- [ ] T025 [US4] (#305) Implement `pullRequests.newSessionFromPullRequest` in `src/main/github/pullRequests.ts`/`src/main/ipc/pullRequests.ts`: call T024's function for the branch, then create the `Session` record exactly as `sessions.create` does (same registry write, same `session:list-changed` emission), substituting the fetched branch; map failures to `checkout-failed`, `worktree-failed`, `path-too-long` (depends on T024, T009).
- [ ] T026 [P] [US4] (#310) Wire `PullRequestDetail.tsx`'s "New session" header action to `pullRequests.newSessionFromPullRequest`, with a loading state, the exact failure shown on error (FR-022's second scenario), and on success switching `view-store.ts` back to `'chat'` for the new Session so it opens selected, per spec 001's existing "created and opened" convention (depends on T025, T010).
- [ ] T027 [US4] (#315) Update `docs/DESIGN.md` and `CONTEXT.md`, then verify live: quickstart.md Story 4, steps 1 to 2.

**Checkpoint**: run quickstart Story 4. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 7: Polish and cross-cutting concerns

**Purpose**: accessibility and documentation close-out across every story.

- [ ] T028 [P] (#319) Accessibility pass across the whole feature: keyboard reachability and a visible focus indicator for every tab, row, dialog, and timeline control (FR-029); confirm no status anywhere (check, pull request state, review outcome, the context-window-style severity badges) is conveyed by colour alone (FR-030); verify on the built app, not only by reading the code.
- [ ] T029 (#324) Update `docs/DESIGN.md` and `CONTEXT.md` with a final summary of the feature (the left-nav entry, the repository dropdown, the list/detail layout, the shared `view-store.ts` primitive) and record the cross-spec hook points spec 004 (the session-readout Pull request chip, which will call `openPullRequests(repositoryId)` with a specific `number` to open) and spec 008 (the active GitHub account) will need once they land, so neither spec has to re-derive this feature's entry points from scratch.
- [ ] T030 (#328) Final docs-and-live-verification task: run every quickstart.md section (Story 1 to 4 plus the untrusted-content and security checks) end to end on the built app in one isolated instance; record the run, including GitHub's actual rate-limit headroom observed per research.md decision 4's probe, as the Checkpoint for this phase.

**Checkpoint**: full quickstart.md passes end to end; `pnpm typecheck` and `pnpm build` pass with no warnings.

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
