---
name: worktree-reap
description: Lane worktree lifecycle for Refract - create a worktree off origin/main, merge the PR, then reap the worktree with pnpm worktrees:reap. Use when starting a lane, merging a lane PR, or when disk is low.
---

# Lane worktree lifecycle

Each lane gets one worktree under the sibling folder `<repo>-worktrees`. The controller removes it after the merge. A lane never removes its own worktree.

## Start of a wave

1. Run `pnpm worktrees:reap --check`. It exits 1 when the worktrees folder holds more than 8 worktrees, the drive has under 20 GB free, or the shared cargo build-script output names a deleted worktree. If it warns, reap first.

## Create a lane

1. Run `git fetch origin`.
2. Run `git worktree add -b <type>/<issue>-<slug> <repo>-worktrees\<type>-<issue>-<slug> origin/main`.
3. Put the literal worktree path in the lane brief. Workers resolve relative paths against the parent session's cwd, not their own worktree.

## Merge

The controller merges the PR as `docs/stacked-prs.md` describes (`gh stack merge` for a stack of two or more, `gh pr merge --squash --delete-branch` for one PR). Do not clean up from inside the lane.

## Reap

1. Run `pnpm worktrees:reap --apply` from any directory outside the worktree you expect to remove. No dry run first: it prints every verdict, reason, and literal target as it goes.
2. Delete the merged lane's scratch folder `%TEMP%\scratch\<task>` by literal path. Scratch files (exe copies, data dirs, probe runs, clones) live only under `%TEMP%\scratch\<task>\`; keep cited evidence in `%TEMP%\scratch\<task>\evidence\` until the PR merges.

A worktree is reaped only when all of these hold: its PR is merged, its tree is clean, the branch tip equals the PR head, it is not the caller's cwd, it is not a Refract Session in `%APPDATA%\refract-tauri\registry.json`, no process command line or executable path names its path (matched on a name boundary at both ends, so `...\wt-1` and `/var/tmp/x/wt` do not count; the drive-letter start anchors the path, so `-IC:\...\wt` glued to a flag does count), and `git worktree remove` (without `--force`) succeeds. Everything else is skipped with a reason.

Before `git worktree remove` the script deletes the worktree's `node_modules` with `rmdir /s /q` on a `\\?\` path (git cannot delete pnpm's directory junctions). If git still fails after deregistering the worktree, the leftover folder is deleted with the guarded husk deleter. After removal the script deletes leftover `node_modules` husks (folders with no `.git` that hold only `node_modules` and whose links resolve inside the folder), then runs `git branch -D` for each removed worktree's branch. Every delete target must sit strictly inside the worktrees folder; the script refuses anything else.

After the reap, the script reads `<CARGO_TARGET_DIR>/debug/build/refract-tauri-*/output` (default `%USERPROFILE%\.cargo-target\refract`). If any path there (for example the `/MANIFESTINPUT:` manifest path) sits under a worktree this run reaped, or under a `src-tauri` folder that no longer exists, the next link would fail on it, so `--apply` runs `cargo clean -p refract-tauri` with that `CARGO_TARGET_DIR` from the main checkout's `src-tauri` and reports it. It skips with a message while `cargo.exe` or `rustc.exe` is running (a lane is building); rerun `--apply` after the build. A dry run only prints `would run: cargo clean -p refract-tauri`. `--check` exits 1 while a stale path is present.

## Options

- `--repo <path>`, `--root <path>`, `--registry <path>` override the defaults. Unknown flags and missing values exit 2 with usage.
- `--apply` refuses (exit 2) when the registry file is absent; `--no-registry` overrides that and turns Session protection off.
- `--pr-fixture <json>` replaces the `gh` lookup. It is test-only, honoured only when both `--root` and `--repo` are under the OS temp directory (otherwise exit 2); `node scripts/worktrees-reap-fixture.mjs` drives it against a scratch fixture.
- A worktree with ignored files other than `node_modules/`, `dist/`, `out/`, `.vite/`, `src-tauri/target/`, `src-tauri/gen/` or a top-level `*.tsbuildinfo` is skipped, and so is one with an open PR. Husks whose name has characters outside `A-Za-z0-9._-` are skipped.
- Exit codes: 0 success; 1 `--check` problem or `--apply` finished with at least one failure; 2 usage error, refusal, or crash.
