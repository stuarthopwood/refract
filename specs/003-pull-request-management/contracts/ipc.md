# Contract: Pull request management (renderer to main)

This extends `src/shared/ipc.ts` (contracts/ipc.md, spec 001) with the `pullRequests.*` requests this feature adds. Same rules apply: the renderer never touches `gh`, the file system, or git directly (constitution V); every request returns `Result<T>` (spec 001 contracts/ipc.md); the preload passes only the named channels below. Types referenced here (`PullRequestSummary`, `PullRequestDetail`, `ChangedFile`, `ReviewVerdict`, `MergeMethod`, `FilterTab`) are defined in [data-model.md](../data-model.md) / `src/shared/github.ts`.

There are no new events. Spec 001's contracts/ipc.md event table is unchanged: checks and timeline updates arrive by the renderer polling `pullRequests.detail` again (research.md "Polling, not push"), not by a push event, because `gh` has no subscribe primitive Refract can use without a stored token or a webhook receiver.

## New `IpcErrorCode` values

| Code | Meaning |
|---|---|
| `no-github-remote` | The repository has no GitHub remote (FR-002). |
| `gh-unavailable` | The GitHub CLI is not installed, not signed in, or otherwise cannot answer (FR-026). |
| `rate-limited` | GitHub reports the authenticated account's rate limit is exhausted (FR-026, Edge Cases). |
| `github-failed` | `gh` or the GraphQL call failed for a reason not covered by a more specific code (the pull request's own error text is included in `IpcError.message`). |
| `stale` | The pull request changed on GitHub since it was last fetched; the action was not attempted (FR-021). |
| `not-mergeable` | A merge was attempted on a pull request GitHub itself reports as not mergeable (conflicts or a failing required check) (FR-020). |
| `checkout-failed` | The pull request's head branch could not be fetched and checked out into a new worktree (FR-022). |

## Requests

### Pull requests (FR-001 to FR-022, FR-026, FR-027)

| Method | Returns | Errors | Notes |
|---|---|---|---|
| `pullRequests.list(repositoryId, tab, query?)` | `{ items: PullRequestSummary[]; fetchedAt: string }` | `no-github-remote`, `gh-unavailable`, `rate-limited`, `github-failed` | `tab: FilterTab`; `query?: string` is the FR-004 narrowing filter, matched client-side-equivalent against title/label by `gh`'s own search. Called on open and on every explicit refresh (FR-006); never polled automatically (FR-028). Second non-polling caller (#569/FR-032): the left-nav sidebar active-count badge calls this with `tab: 'involves'`, `query: 'is:open'` for the default repository (the focused pane's Session's repository, independent of this view's own repository dropdown), triggered only by app start, a default-repository change, window focus (throttled), an active-account change, and the view's own explicit refresh — never a timer.
| `pullRequests.detail(repositoryId, number)` | `PullRequestDetail` | `no-github-remote`, `not-found`, `gh-unavailable`, `rate-limited`, `github-failed` | Called on open, and again by the renderer's own polling loop while `checkState === 'pending'` (FR-010); each call refreshes the main-process cache used for the staleness check. |
| `pullRequests.comment(repositoryId, number, body)` | `{ id: string }` | `stale`, `gh-unavailable`, `rate-limited`, `github-failed` | FR-012. `body` is markdown text, sanitised the same way on render as everything else (FR-023); the request itself takes plain text, no HTML. |
| `pullRequests.replyToThread(repositoryId, number, threadId, body)` | `{ id: string }` | `stale`, `not-found`, `gh-unavailable`, `rate-limited`, `github-failed` | FR-013. `threadId` is a `ReviewThread.id`; the reply is linked to that thread's opening comment (GraphQL `inReplyTo`), never a new unrelated comment. |
| `pullRequests.resolveThread(repositoryId, number, threadId)` / `pullRequests.unresolveThread(repositoryId, number, threadId)` | `void` | `stale`, `not-found`, `gh-unavailable`, `rate-limited`, `github-failed` | FR-014. Each is a single explicit action (SC-006); resolving then unresolving returns the thread to its prior state. |
| `pullRequests.submitReview(repositoryId, number, { verdict, body?, expectedHeadSha })` | `{ id: string }` | `stale`, `disabled`, `gh-unavailable`, `rate-limited`, `github-failed` | FR-015. `verdict: Exclude<ReviewVerdict, 'dismissed'>` (gate round 3 fix, #568 decision 10 amendment: `'dismissed'` is a real state an already-submitted review can be in, shown in the Overview timeline, but never a choice a NEW submission can carry). The renderer calls this only after the caller-side confirmation for `'approve'`/`'request-changes'` (FR-017, `ReviewDialog.tsx`); `'comment'` needs no confirmation (only approve/request-changes/merge do, FR-017). `disabled` mirrors the pull request's current `reviewDisabledReason` (FR-019) and is returned instead of attempting a review on a draft, closed, or merged pull request even if the renderer's own gate were bypassed. `expectedHeadSha` (security remediation, round 3, High): the renderer's own `PullRequestDetail.headSha` snapshot from the moment the Review dialog opened; main refuses with `stale` unless a fresh re-fetch's `headSha` still matches it — the in-process staleness cache alone is not enough, since the 15s background poll keeps re-seeding it even while the dialog sits open. |
| `pullRequests.merge(repositoryId, number, { method, expectedHeadSha })` | `void` | `stale`, `not-mergeable`, `disabled`, `gh-unavailable`, `rate-limited`, `github-failed` | FR-016, FR-020. `method: MergeMethod`, must be one of `PullRequestDetail.allowedMergeMethods`; the renderer's confirmation (`MergeDialog.tsx`) names the pull request and this method (FR-017). `not-mergeable` is returned for conflicts or a failing required check even if `mergeableState` briefly read `'mergeable'` (a just-landed change on GitHub). `expectedHeadSha`: identical reasoning to `submitReview`'s own field above — captured when `MergeDialog` opens, checked against a fresh re-fetch, and the actual `--match-head-commit`/mutation is pinned to this renderer-supplied value, not to the fresh re-fetch's `headSha` alone. |
| `pullRequests.newSessionFromPullRequest(repositoryId, number)` | `Session` | `checkout-failed`, `worktree-failed`, `path-too-long`, `gh-unavailable`, `rate-limited`, `github-failed` | FR-022. Fetches the pull request's head branch (research.md decision 6) and creates a Session exactly as `sessions.create` does, substituting the fetched branch for a new one cut from a Base branch; on any failure, no partially created worktree, branch, or Session is left behind, matching `sessions.create`'s own guarantee (spec 001 contracts/ipc.md). |

## Preload surface

`src/preload/index.ts`'s `window.refract` gains one new namespace, `pullRequests`, with exactly the methods above — no other channel is exposed, matching the existing allowlist pattern for `repositories`, `sessions`, `chat`, and `settings`.
