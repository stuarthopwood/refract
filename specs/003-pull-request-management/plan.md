# Implementation Plan: Pull request management

**Branch**: `003-pull-request-management` (no branch created; work lands on `main`) | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-pull-request-management/spec.md`

## Summary

Add a repository-scoped "Pull requests" view to Refract: a list (Open / Authored by me / Assigned to me / Involves me / Review requested, with a narrowing filter) and a detail pane (Overview with timeline and review threads, Changes with per-file diffs), plus review actions (comment, reply, resolve/unresolve, submit review, merge) and "New session from a pull request". All GitHub access runs through the developer's already-signed-in GitHub CLI (`gh`) from the main process — porcelain commands (`gh pr list`, `gh pr view`, `gh pr review`, `gh pr merge`) for most of it, `gh api graphql` for the GitHub-API surface `gh`'s porcelain doesn't expose (review-thread resolution state, reply-in-thread, and the timeline). No token is stored (FR-027); Refract shells out to `gh` exactly as it already shells out to `git`. Design rationale and the unverified `gh`/GitHub-API facts this plan depends on are in [research.md](research.md); the new IPC surface is in [contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1; React 19.3.0 in the renderer. Same toolchain as spec 001; no change.

**Primary Dependencies**: no new npm package. Reuses spec 001's `react-markdown` + `rehype-sanitize` (`Markdown.tsx`) for all pull request text, `react-diff-view` (`DiffView.tsx`) for per-file diffs, and shadcn/ui primitives already in the repository (`Dialog`, `AlertDialog`, `Select`, `Badge`, `Collapsible`, `ScrollArea`, `Button`, `Tooltip`). One shadcn component is newly copied in: `Tabs` (for the filter tabs and the Overview/Changes tabs), via `pnpm dlx shadcn@4.21.0 add tabs`, matching how spec 001 T002 copied the other primitives. The GitHub CLI (`gh`) is an external prerequisite, resolved the same way `git` is (`src/main/process/executables.ts`), never bundled.

**Storage**: none. Pull request data is fetched live from GitHub through `gh` and held only in main-process memory, keyed by `(repositoryId, number)`, for the staleness check (FR-021) and to avoid re-fetching on every render; nothing is written to `registry.json`, `settings.json`, or any new file.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is verified by running the app per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build` must pass before a change lands on `main`.

**Target Platform**: Windows 11 only (constitution, Platform and Stack).

**Project Type**: desktop-app (Electron: main, preload, renderer) — extends the existing spec 001 project, no new project.

**Performance Goals**: from the spec: Open list visible within 3 s under normal network conditions (SC-001); a pull request's Overview, including its timeline, within 2 s for a typical-sized pull request (SC-003); a submitted comment, resolution, or review reflected within 2 s without a manual refresh (SC-004); the Subagents-style polling this implies for check status is capped so it does not noticeably add to `gh`'s per-hour rate budget (research.md "Polling, not push").

**Constraints**: no stored GitHub token (FR-027); every GitHub read and write goes through `gh`, which itself enforces GitHub's authenticated rate limits (typically 5,000 REST points/hour and a separate GraphQL points budget) — Refract must surface a `rate-limited` state rather than retry silently; renderer is sandboxed and never touches `gh`, the file system, or git (constitution V); no remote image ever loads in the window (FR-024); the active GitHub account is whichever one `gh` itself has active until spec 008 lands its account switcher (research.md decision 1).

**Scale/Scope**: one repository's pull request list at a time (scoped by the existing repository selection, like Sessions); open-pull-request counts in the tens for a typical repository; 30 requirements across 4 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass, N/A for most of this feature | This feature does not add any OMP RPC usage. Its one touchpoint with OMP is User Story 4, which creates a Session exactly through spec 001's existing `sessions.create`-equivalent rules (same worktree/Job-Object/reattach machinery, unchanged) — it only supplies a different branch source (a fetched pull-request head branch instead of a new branch off a Base branch). No new `omp --mode rpc-ui` flag, frame, or native command is introduced. |
| II. RPC wire contract | Pass, N/A | No new OMP wire usage; nothing in this feature talks to an `OmpProcess`. |
| III. Session and process lifecycle | Pass | User Story 4 reuses the Session lifecycle unchanged: the new worktree is created with the same "no half-created Session" guarantee as `addWorktree` (research.md decision 6), and the resulting Session is started, reattached, and tracked exactly like one created from `sessions.create`. |
| IV. Evidence before design | Pass, with named gaps | Every `gh` CLI and GitHub GraphQL shape this plan depends on (list/view JSON fields and filter queries, review-thread and timeline shapes, automated-reviewer finding representation, rate-limit and large-diff signals, fork-safe PR-branch checkout) is unverified on this machine's `gh` version and is scheduled as the first five tasks (T001 to T005), each a probe script under `docs/spike/`, recorded in `docs/spike/FINDINGS.md` before the task that depends on it. research.md "Unknowns" lists every item. |
| V. Electron security baseline | Pass | Only the main process spawns `gh` (via `src/main/github/gh.ts`, following the existing `resolveExecutable` pattern so a repository cannot shadow `gh.exe` the same way `git.exe` was hardened against); the renderer reaches it only through new, typed, allowlisted `pullRequests.*` channels (contracts/ipc.md). All pull request text renders through the existing `Markdown.tsx` sanitiser (`rehype-sanitize`), never as raw HTML. No avatar or inline image is ever fetched or loaded by the renderer; authors show as name or initials (research.md decision 9) and markdown images render as alt text plus a link (research.md decision 8). Every link (GitHub or otherwise) opens via the existing `shell.openExternal` path, never in-app navigation. |
| Platform and Stack | Pass | Windows 11 only; new main-process code lives in `src/main/github/`, parallel to the existing `src/main/git/`; same Electron + Vite + React, strict TypeScript. |
| Development Workflow | Pass | Spec Kit order (`/speckit.plan` → `/speckit.tasks` → `/speckit.implement`); no automated tests; typecheck and build gate before landing on `main`. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-pull-request-management/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions and what is unverified
├── data-model.md         # pull request, review, thread, check, finding, changed-file shapes
├── quickstart.md         # how to run and verify each story
├── contracts/
│   └── ipc.md            # the new `pullRequests.*` renderer-to-main channels
├── checklists/requirements.md
└── tasks.md               # produced by /speckit.tasks
```

### Source code (repository root, additions only — existing files below are extended, not replaced)

```text
src/
├── shared/
│   ├── github.ts               # NEW: PullRequestSummary, PullRequestDetail, Review, ReviewThread,
│   │                           #      ReviewComment, Check/CheckState, AutomatedFinding, ChangedFile,
│   │                           #      TimelineEntry, MergeMethod, FilterTab (data-model.md)
│   └── ipc.ts                  # EXTENDED: `pullRequests.*` requests, new IpcErrorCode values
├── main/
│   ├── github/
│   │   ├── gh.ts                # NEW: execFile wrapper for `gh`, resolved via resolveExecutable,
│   │   │                        #      typed GhError codes (mirrors src/main/git/git.ts)
│   │   ├── graphql.ts           # NEW: `gh api graphql` query/mutation helper built on gh.ts
│   │   └── pullRequests.ts      # NEW: list, detail, timeline, changed files/diff, submitReview,
│   │                           #      comment, replyToThread, resolveThread/unresolveThread, merge,
│   │                           #      headBranchForWorktree; per-(repositoryId, number) cache for
│   │                           #      the FR-021 staleness check
│   └── ipc/
│       └── pullRequests.ts      # NEW: registerPullRequests(manager, getWindow) — wires every
│                                #      `pullRequests.*` channel to github/pullRequests.ts
└── renderer/
    ├── state/
    │   ├── pull-requests-store.ts  # NEW: zustand store for the list/detail/filter-tab state
    │   └── view-store.ts           # EXTENDED (shared cross-spec primitive; specs 004/008 add
    │                               #           their own variants to the same file): adds the
    │                               #           `'pull-requests'` member to the shared `MainView`
    │                               #           union and an `openPullRequests(repositoryId)`
    │                               #           action; `repositoryId` and `view` field names
    │                               #           per the agreed cross-spec shape (research.md
    │                               #           decision 7)
    └── features/
        ├── sessions/
        │   └── SessionList.tsx     # EXTENDED: a "Pull requests" toggle button in each
        │                           #           RepositoryGroup header, beside the existing +
        │                           #           and branch buttons
        └── pull-requests/           # NEW feature folder
            ├── PullRequestsView.tsx     # top-level view: list + detail, mounted in App.tsx in
            │                           # place of ChatPane while view-store's `view` is
            │                           # `'pull-requests'`
            ├── PullRequestList.tsx      # filter tabs, narrowing filter, refresh + last-updated
            ├── PullRequestRow.tsx       # one row: title, number, check icon+text, repo, age, author
            ├── PullRequestDetail.tsx    # header (title/number/state/branches/people/labels),
            │                           # Overview/Changes tabs, header actions
            ├── Timeline.tsx             # commits, comments, reviews, review threads in order,
            │                           # automated-reviewer findings with severity
            ├── ChangesTab.tsx           # changed files, totals, per-file DiffView, truncation
            ├── ReviewDialog.tsx         # Approve / Request changes confirmation (AlertDialog)
            └── MergeDialog.tsx          # Merge confirmation + method picker (AlertDialog)
docs/spike/                          # probe scripts and findings (already present, spec 001)
```

**Structure Decision**: this feature extends spec 001's single Electron project; no new source root. The reference screenshot's "left nav" (a persistent rail of named views) does not exist in the code yet — specs 004, 007, and 008 are the ones that build it (Settings entry, theme switcher, profile item). Building a left-nav shell here would duplicate work those specs own and create a second convention before the first one lands. Instead, this feature's entry point is a small, repository-scoped toggle added to the per-repository header `SessionList.tsx` already renders (where the existing "new session" and "branch picker" buttons live), which calls the shared `view-store.ts`'s `openPullRequests(repositoryId)` to swap `App.tsx`'s main pane between `ChatPane` and `PullRequestsView` for that repository — the same scoping Sessions already use, and the same shared store specs 004 and 008 extend with their own views (`'settings'`, `'manage-sessions'`) rather than each spec inventing its own switch state. When the real left nav lands, only this toggle's mount point moves; `PullRequestsView` itself does not change. This is recorded as research.md decision 7, not a constitution violation (no principle requires a left nav; FR-001 only requires "the left nav MUST include a 'Pull requests' entry" once such a nav exists, and today's equivalent surface is the per-repository header).

## Design overview

- **One cache, keyed by `(repositoryId, number)`.** `src/main/github/pullRequests.ts` holds the last-fetched `PullRequestDetail` per key in memory; every mutating request (comment, reply, resolve/unresolve, submit review, merge) re-fetches just the comparison fields (`updatedAt`, `headSha`) first and returns `stale` instead of acting when they differ from the cached snapshot (FR-021). A successful mutation replaces the cache entry with the server's response so the view never shows an outcome that doesn't match reality (FR-018).
- **Polling, not push.** There is no GitHub webhook receiver and no new OMP event; the renderer calls `pullRequests.detail` again on an interval while a check is `pending` or the detail view is open (FR-010), and calls `pullRequests.list` only when the user asks for a refresh (FR-006, FR-028 — no automatic or background review/merge/resolve variant). The interval and its rate-limit headroom are a research.md decision, confirmed by probe T004.
- **`gh` the same way `git` is used.** `src/main/github/gh.ts` mirrors `src/main/git/git.ts`: resolve the executable from `PATH` (never the repository's cwd), run with no shell, parse `--json` output, map failures to typed codes. `src/main/github/graphql.ts` builds on it for the one GitHub-API surface `gh`'s own commands don't cover.
- **Untrusted content everywhere.** Every title, body, comment, automated-reviewer finding, and branch name renders through the existing `Markdown.tsx` sanitiser or as plain text; no avatar or inline image is ever fetched; links open externally (constitution V, FR-023 to FR-025).
- **Session creation is unchanged.** "New session" from a pull request produces exactly the `Session` shape and guarantees spec 001 already defines; it differs only in how the worktree's branch is obtained (an existing, fetched branch rather than a new one cut from a Base branch).

## Phase 1 re-check (post-design)

The data model and the new IPC contract introduce no new process, no network access from the renderer (all `gh` calls are main-process only), and no renderer capability beyond those already covered by the Constitution Check. The five unverified `gh`/GitHub-API facts (list/view fields and filters, review-thread and timeline shapes, automated-reviewer representation, rate-limit and large-diff signals, fork-safe PR-branch checkout) are each a scheduled probe task (T001 to T005) before any task that depends on them, per constitution Principle IV; none of the later design changes on their outcome in a way that would alter this Constitution Check.

## Complexity Tracking

None.
