# Test strategy

This page describes how Refract tests a change before it merges: a fast tier that gives feedback in
minutes, and a full suite that gates the merge. It also names the three areas where the next
round of tests (#1809) pays off most.

The rule that new and changed logic carries co-located unit tests lives in `AGENTS.md` ("Testing").
This page covers *where* tests run, not how to write them.

## Test tiers

| Tier | Command | Runs where | Budget | Purpose |
| --- | --- | --- | --- | --- |
| Fast | `pnpm test:fast` | Locally, on demand | 3 minutes | Feedback while you work |
| Fast | `.github/workflows/pr-fast.yml` | GitHub Actions, on pull requests to `main` | 3 minutes of work, 10-minute timeout | Catch regressions on every PR |
| Full | `pnpm ci:local` | Locally | None | The merge gate |

### Fast tier

The fast tier is `vitest --changed` plus the `check:*` scripts. It needs no cargo, no Windows
runner, and no built bundle, so it stays cheap enough to run on every push to a PR branch.

Locally, `pnpm test:fast` (`scripts/test-fast.mjs`) does the following, in order, and stops at the
first failure:

1. Checks that `origin/main` exists (`git rev-parse --verify origin/main`) and stops with a message
   if it does not. Run `git fetch origin main` first in a fresh clone or worktree.
2. Runs `vitest run --changed origin/main`, which runs only the test files affected by your
   changes since `origin/main`. A change that touches no test-covered module passes.
3. Runs the `check:*` scripts: `check:indent`, `check:theme-contrast`, `check:theme-ids`,
   `check:drag-regions`, `check:parity -- --gate`, `check:file-size`, `check:comment-density`,
   `check:spacing`, `check:alpha-modifiers`, `check:icon-only-controls`, `check:literal-colours`,
   `check:hit-targets`, `check:advisor-roster`, `check:versions`, and `check:omp-schema` (with
   `--check-pin`, plus its `--self-test`).
4. Prints the total time and warns if it went over the 3-minute budget.

In Actions, the same checks run on `ubuntu-latest` for every pull request to `main`, with two
differences: the job runs `pnpm typecheck` first, and it runs the whole vitest suite (`pnpm test`)
instead of only the changed files, because a PR job has no local state to diff against.

The fast tier does not run:

- `cargo fmt`, `cargo clippy`, or `cargo test`.
- `pnpm tauri build` and `check:ui-text`, which scans the bundle that build writes. It is the one
  `check:*` script in `.github/ci-local.yml` that the fast tier leaves out: it cannot run without
  the build output, and the build needs cargo.
- Any Windows-only step.

The fast tier is a smoke test, not a gate. A green fast tier does not mean the change is safe to
merge.

#### Keep the fast tier fast

If `pnpm test:fast` regularly passes 3 minutes, trim it instead of raising the budget. Move the
slowest step to the full suite only. The steps in `pr-fast.yml` must stay a subset of the steps in
`.github/ci-local.yml`, so the full suite never runs less than the fast tier. The test
`scripts/test-fast.test.mjs` fails when a `pr-fast.yml` step is missing from `ci-local.yml`, or when
the `check:*` steps of `pr-fast.yml` and `scripts/test-fast.mjs` differ.

### Full suite

`pnpm ci:local` is the merge gate. It replays every `run:` step of `.github/ci-local.yml`, in order:
typecheck, vitest, the `check:*` scripts, `cargo fmt --check`, `cargo clippy --all-targets -- -D
warnings`, `cargo test`, the debug Tauri build, and `check:ui-text`.

Run it before you open a PR and again on the merged tree. It needs `CARGO_TARGET_DIR` set to a
shared directory outside the repository (`docs/rust-build.md`).

`.github/ci-local.yml` lives outside `.github/workflows/` on purpose. The full Windows suite used up
the Actions minutes on 2026-10-14, so GitHub Actions never runs it, and there is no scheduled
(nightly) run. To list its steps without running them, use `node scripts/ci-local.mjs --list`.

## Highest-risk areas for new tests

The #1809 backfill covers these three areas first. Each one is expensive to get wrong, hard to
notice in a quick manual check, and touches state outside the app's own process.

| Area | Why it is risky | Where it lives |
| --- | --- | --- |
| Updater and install | A bad update can strand a user on a broken build. It downloads, verifies a checksum, runs an installer, and installs on quit. | `src-tauri/src/updates/`, `src-tauri/src/ipc/updates.rs`, `src/shared/updates.ts`, `src/renderer/state/update-store.ts`, `src/renderer/lib/updateStatus.ts` |
| Away Mode and approval policy | Away Mode lets an agent keep working while the user is gone. A wrong approval decision either blocks the agent or lets it do something the user never allowed. | `src-tauri/src/session/working_mode/`, `src-tauri/src/agent_tools/approval.rs`, `src-tauri/src/store/approval_mode.rs`, `src/renderer/features/chat/approvalOptions.ts` |
| Worktree and Session lifecycle | Sessions create, hold, and delete git worktrees. A bug can delete a worktree that holds uncommitted work, or leave one behind that fills the disk. | `src-tauri/src/git/worktrees.rs`, `src-tauri/src/git/worktree_delete*.rs`, `src-tauri/src/git/worktree_holders.rs`, `src-tauri/src/session/` |

When you pick up #1809, write tests that exercise the decision logic (for example, "does this
approval request auto-resolve in Away Mode?") through the same shared test utilities the rest of
the repository uses, and keep them deterministic.

## What to run when

| You are about to... | Run |
| --- | --- |
| Save a change and want quick feedback | `pnpm test:fast` |
| Push a branch | `pnpm test:fast` |
| Open a PR or merge | `pnpm ci:local` |
| Change only docs | The docs-only rules in `AGENTS.md` |
