# Contract: renderer to main (typed IPC) — additions for Profile and accounts

Extends specs/001-core-session-workspace/contracts/ipc.md: same `Result<T>` shape, same
`window.refract` bridge, same rule that the preload passes only the named channels through. This
file lists only what this spec adds.

## Requests

### GitHub accounts (FR-006 to FR-015)

| Method | Returns | Errors |
|---|---|---|
| `accounts.github.list()` | `GitHubAccount[]` (data-model.md), one entry per account the GitHub CLI knows about across every host, active one(s) marked | `gh-not-found` (the GitHub CLI is not installed) |
| `accounts.github.addStart()` | `{ flowId: string }` | `gh-not-found`, `gh-failed` |
| `accounts.github.addCancel(flowId)` | `void` | |
| `accounts.github.switch(host, login)` | `GitHubAccount[]` (the refreshed list) | `gh-not-found`, `gh-failed`, `account-not-found` |
| `accounts.github.signOut(host, login)` | `GitHubAccount[]` (the refreshed list; empty-of-active when no account remains) | `gh-not-found`, `gh-failed`, `account-not-found` |

`addStart` runs `gh auth login --hostname github.com --web` in the background and immediately
returns a `flowId`; its one-time code and progress stream over the `accounts:github-add-progress`
event (below), ending with `status: 'completed' | 'cancelled' | 'failed'`. `addCancel` kills that
process (stdin close, then force after a short grace, the same two-step `OmpProcess.stop()`
already uses) and emits one final `accounts:github-add-progress` with `status: 'cancelled'`.
`switch` and `signOut` always pass explicit `--hostname`/`--user` flags (research.md decision 1),
never an ambiguous interactive call.

### OMP provider sign-in (FR-016, FR-017 — User Story 3)

| Method | Returns | Errors |
|---|---|---|
| `accounts.omp.list()` | `OmpProviderState[]` (data-model.md) | `omp-probe-failed` |
| `accounts.omp.signIn(providerId)` | `{ requestId: string \| null }` | `omp-probe-failed`, `unsupported` (research.md decision 6 fallback) |
| `accounts.omp.signOut(providerId)` | `{ requestId: string \| null }` | `omp-probe-failed`, `unsupported` |
| `accounts.omp.answer(requestId, answer)` | `void` | `not-found` |

`signIn`/`signOut` start the scratch management `OmpProcess` (contracts/omp-usage.md), send
`/login`/`/logout`, and return a `requestId` only when the attempt actually raised a dialog the
developer must answer (`accounts:omp-request` below carries its content); `requestId: null` means
the command ran to completion with no dialog (for example a provider that was already in the
requested state). `answer` has the same shape as `chat.answer`'s `answer` parameter
(`ChatAnswer`, specs/001 contracts/ipc.md), reusing `dialogs.ts`'s existing answer builder.
`unsupported` is returned for every call in this section: research.md decision 6 (FINDINGS item
43) confirmed `/login`/`/logout` cannot be driven over rpc-ui; the renderer shows the read-only
fallback (list only, with a "run `omp login` in a terminal" instruction -- never `/logout`, which
has no terminal counterpart in the installed version) and never calls `signIn`/`signOut`.

### Release notes (FR-023 — What's new)

| Method | Returns |
|---|---|
| `app.openReleaseNotes()` | `void` |

Opens `https://github.com/stuarthopwood/refract/releases/tag/v<app.getVersion()>` in the system
browser via the same bounded, scheme-checked helper `index.ts`'s `openExternalSafe` already uses
for every other external link (constitution V); never opened inside an app window.

### Update state (owned by spec 006, consumed here — FR-021)

| Method | Returns |
|---|---|
| `updates.get()` | `{ state: 'up-to-date' \| 'checking' \| 'available'; version?: string }` |

This method and its `updates:changed` event are spec 006's contract to define and implement; this
spec's profile menu only consumes them to render "Restart to update <version>" or "Check for
updates" (plan.md "Build order"). Listed here only so the profile menu's task has a concrete shape
to build against; `src/main/ipc/updates.ts` itself is spec 006's file, not this spec's.

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `accounts:github-changed` | `GitHubAccount[]` | Manage accounts and the profile item re-render; pushed after `switch`/`signOut` and whenever the main process notices the GitHub CLI's state changed (for example a sign-in finishing). |
| `accounts:github-add-progress` | `{ flowId: string; code: string; status: 'waiting' \| 'completed' \| 'cancelled' \| 'failed'; detail?: string }` | The add-account dialog's one-time code and progress (FR-009). |
| `accounts:omp-changed` | `OmpProviderState[]` | Manage accounts' OMP section re-renders. |
| `accounts:omp-request` | `{ requestId: string; request: PendingRequest }` | A dialog raised by `/login`/`/logout` that the developer must answer, reusing specs/001's `PendingRequest` shape (data-model.md). |
| `accounts:omp-request-resolved` | `{ requestId: string }` | The dialog above is answered or the flow ended. |

## Windows notifications

No change: this spec adds no new notification; the existing rule (specs/001 contracts/ipc.md
"Windows notifications") is unchanged.
