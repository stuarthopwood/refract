# Research: gh stack behaviour (verified 2026-11-12, read-only)

Sources: `gh extension list` (gh-stack v0.3.0, installed), `gh stack --help`, `docs/stacked-prs.md`, gh-stack source (`github/gh-stack` `cmd/view.go`, `cmd/merge.go`, `cmd/utils.go`, `cmd/root.go`). Nothing was installed.

## `gh stack view --json`
- Non-interactive and safe; a bare `view` opens a TUI and hangs. Needs a local checkout: it reads the stack file `.git/gh-stack` (`schemaVersion` 1, `repository`, `stacks[]` with `trunk`, `branches[]`, `pullRequest`). A stack made on another machine is not listed.
- Output shape (`viewJSONOutput`): `{ trunk, currentBranch, branches: [{ name, head, base, isCurrent, isMerged, isQueued, needsRebase, pr?: { number, url, state } }] }`. `state` is `OPEN`, `MERGED` or `QUEUED`. Order is bottom to top; `pr` is absent for an unsubmitted branch.
- It reports the stack of the current branch (or the one named by argument), so Refract runs it per candidate head branch in the Project checkout, not once.
- Exit 2 when the branch is not in a stack; exit 5 for invalid args.

## Exit codes (`cmd/utils.go`)
2 not in stack, 3 rebase conflict, 4 GitHub API failure, 5 invalid args, 6 ambiguous stack/remote, 7 rebase active, 8 lock failed, 9 stacks unavailable, 10 recovery required.
- Exit 9 comes from a 404 on the stacks API (`warnStacksUnavailable`). v0.1.0 returns it falsely, so v0.3.0 is the floor.

## `gh stack merge [<stack-number> | <pr-number>] --yes --squash`
- Merges every layer from the bottom up to and including the target atomically, all or nothing. Middle layer is therefore allowed; GitHub evaluates protections and reports failures.
- **Hazard:** a bare number is tried as a stack number first (`GetStack(n)`), then as a pull request number (`FindStackForPR(n)`). If a stack numbered N exists, `gh stack merge N` merges that stack, not PR #N. Refract must resolve the stack number from the PR first (plan, D2).
- It reads no local PR state when an argument is given, so it needs only a cwd with a GitHub remote.
- Merge queue: the stack is enqueued; `--squash` is ignored with a warning.
- `--yes` and non-TTY merge without prompts. A draft or closed layer below the target blocks it (`explainNonMergeableTarget`).

## Missing extension
`gh stack` with no extension returns `unknown command "stack" for "gh"` (observed: `gh zzzstack` returns the same shape). Probe `gh stack --version`; a non-zero exit with that text is `missing`.

## REST
`GET repos/{owner}/{repo}/stacks?pull_request=<n>` returned `[]` for an unstacked PR (observed). The response shape for a stacked PR was not observed (no stacked PR on this repo at probe time); implement spikes it (tasks T003) before relying on it.

## Open for implement (each has a spike task)
- Whether `omp` accepts `--append-system-prompt` twice (help text shows it once). Plan avoids the question: stack text goes in the same rules file (D5).
