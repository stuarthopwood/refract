# Plan: spec 096

## Rust

- `store/registry.rs`: `Session.origin_issue: Option<OriginIssue>` (`#[serde(default, skip_serializing_if)]`).
- `git/worktrees.rs`: `add_worktree_for_issue` over `add_worktree_with_candidates` (`issue-<n>-<slug>`, then `-2`, ...).
- `github/gh_permission.rs`: `author_has_write_access` (fail closed).
- `ipc/session_kickoff.rs`: kickoff builder (fence, caps), `issues.newSession`, and the shared `Kickoff` type used by `pullRequests.newSessionFromPullRequest`.

## Renderer

- `features/sessions/startSessionFromItem.ts`: existing-Session lookup, the IPC call, kickoff apply (send or prefill).
- `features/sessions/githubItemRef.ts`: parse a pasted URL or number.
- `NewSessionDialog`: item field that switches the dialog mode; palette items open it in a preset mode via `newSessionRequestStore`.
- Issues row action, pull request row context menu, palette items, PR detail button all call `requestSessionFromItem`.
- `draft-store`: `kickoffNotice`; `MessageInput` renders it as a polite live region.
- `HeaderPrControls`: prepends the Session `originIssue` to `linkedIssues`, de-duplicated by number.

## Security

Bodies are untrusted: fenced and capped, header outside the fence. The permission check fails closed. Principle V: new IPC commands validate their arguments and add no capability.
