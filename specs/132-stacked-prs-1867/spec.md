# Feature Specification: Stacked pull requests via gh stack

**Issue**: #1867 | **Route**: specify (spec 132) | **Follow-up**: #1966 (installer bundles gh-stack, spec 006) | **Related**: #660, #117, #1304, #1859

## Summary

Settings gets a **Stacked pull requests** toggle, on by default. While it is on and `gh stack` is usable, (1) Session notes tell the agent to open pull requests with `gh stack`, (2) the Pull requests view's **Merge** button merges a stacked pull request through `gh stack merge`, and (3) the Pull requests view shows each stacked pull request's position ("2 of 3") with links to the other layers. While it is off, or `gh stack` is missing or unsupported, Refract behaves exactly as today. Refract ships only an in-app **Install** button; bundling in the installer is #1966.

## User stories

### US1 (P1): Agents open stacked pull requests
A new Session's notes carry the `gh stack` instructions when the toggle is on and `gh stack` is usable. When off, they say nothing about stacks.
- **FR-001** Setting `stackedPullRequests: boolean`, default `true`, persisted across restarts, changes announced like other settings.
- **FR-002** When on and gh-stack is `ready`, the launch args add a stack block: `gh stack init`/`add` plus `gh stack submit --auto`, dependent work in one stack bottom to top, branch names positional, never a bare `view`/`init`/`submit` (they prompt). When off, or state is not `ready`, no stack text is added.
- **FR-003** The notes are a fixed block (commands as in `docs/stacked-prs.md`: positional branch names, `submit --auto`, `view --json`; exit 9 means stop and report); they embed no per-user data.
- **FR-015** The pull request number reaches `gh` as a validated positive integer argv element; no shell and no string-built command (Constitution V).

### US2 (P1): Merge routes through gh stack
- **FR-004** **Merge** on a pull request known to be stacked runs `gh stack merge <pr> --yes --squash` in the Project's checkout instead of `merge_pull_request`'s `gh pr merge` path. An unstacked pull request keeps today's path unchanged.
- **FR-005** "Stacked" is decided by `gh stack view --json` (parsed from the Project's local checkout) when the Project has one; otherwise by base/head chaining over the loaded pull requests (a pull request whose base branch is another's head branch, or whose head is another's base, is in a stack with it).
- **FR-006** Merging a middle layer is not special-cased: `gh stack merge <pr>` merges every layer up to and including it atomically; Refract passes it through and shows `gh stack`'s own error on refusal. The Merge dialog says so ("merges layers 1 to N together").
- **FR-007** The merge result maps `gh stack` exit codes to the existing merge error surface: 2 not in stack, 3 conflict, 4 API failure, 5 invalid arguments, 6 ambiguous, 7 rebase active, 8 lock failed, 9 stacks unavailable, 10 recovery required; all show the CLI's stderr text.

### US3 (P1): Stack position in the view
- **FR-008** A stacked pull request's row and detail show its position ("2 of 3") and links to the other layers (number, title, state, opens in the view).
- **FR-009** Merged and queued layers are shown as such (`isMerged`, `isQueued`); a layer that `needsRebase` shows a short note.
- **FR-010** Positions from chaining carry no `needsRebase`; the UI omits that note rather than guessing.

### US4 (P1): Missing or old extension, and exit 9
- **FR-011** gh-stack state is one of `ready`, `missing`, `outdated` (< v0.3.0, whose false exit 9 would mislead), `unavailable-for-repo` (exit 9, per repository). It is probed with `gh stack --version`; `missing` is `gh`'s "unknown command" error.
- **FR-012** In `missing`/`outdated`, Settings and the **Merge** dialog show "gh-stack is not installed" (or "needs updating") with an **Install** button that runs `gh extension install github/gh-stack` (`gh extension upgrade gh-stack` when `outdated`), then re-probes and clears the prompt. Until `ready`, Refract behaves as if the toggle were off; the toggle itself stays on.
- **FR-013** `unavailable-for-repo` is kept in memory only, per repository, never persisted, and cleared by a re-probe on each launch. The message "Stacks are not enabled for this repository" shows once and plain pull requests are used for that repository.
- **FR-014** The Install runs with the `gh` Refract resolves (`resolve_gh`, portable first); a failure shows `gh`'s stderr and leaves the prompt.

## Edge cases
- No local checkout and no chain: the pull request is unstacked; today's merge path.
- Chain data says stacked but `gh stack merge` reports exit 2: show the error; do not silently retry with `gh pr merge`.
- A bare number to `gh stack merge` is tried as a stack number before a pull request number (research.md): Refract refuses, with a clear error, when a stack with that number exists and does not contain the pull request (plan D2 guard).
- Toggle turned off while a merge dialog is open: the dialog re-reads the setting and falls back to the plain path.
- `gh` itself missing: existing `GhUnavailable` handling; no gh-stack prompt.

## Success criteria
- **SC-001** Toggle default on, survives restart (unit + live).
- **SC-002** Notes contain `gh stack submit --auto` iff on and `ready` (unit on args).
- **SC-003** A stacked pull request merges through `gh stack merge` with the exact argv; an unstacked one calls `gh pr merge` (unit on argv builders + live with fake gh).
- **SC-004** Position and links render for a 3-layer stack (live screenshot).
- **SC-005** Missing extension shows the prompt in both places; Install clears it (live with fake gh).
- **SC-006** Exit 9 falls back for that repository only and is re-probed after relaunch.

## Out of scope
Installer bundling (#1966); creating stacks from Refract's UI; merging the whole stack from a middle layer differently; a `gh stack` rebase/sync UI.

## Clarifications

### Session 2026-11-12
- Decided (Stuart, 2026-11-12): stack data comes from `gh stack view --json` when the repo has a local checkout, otherwise base/head chaining; merge routing reuses the same data; a middle-layer merge is left to `gh stack merge` and its error is shown.
- Decided (Stuart, 2026-11-12): the exit-9 state is in memory and re-probed each launch; the toggle stays on with an inline "not installed" state and an **Install** button.
- Decided (Stuart, 2026-11-12): the installer change is #1966; this lane ships only the in-app **Install** button.
- Decided (Skippy, delegated): below v0.3.0 counts as `outdated` with an upgrade button, because the false exit 9 in v0.1.0 would otherwise trigger the repository fallback wrongly (docs/stacked-prs.md).
- Decided (Skippy, delegated): Refract never falls back from a failed `gh stack merge` to `gh pr merge`; a silent retry could merge a layer out of order and hide the cause.
- Decided (Skippy, delegated): stack notes are added only in `ready`; `missing` or `outdated` produce no stack text, since the agent cannot run commands that do not exist.
- Decided (Skippy, delegated): Install and probe use the `gh` that `resolve_gh` returns, so the portable `gh` gets the extension.
