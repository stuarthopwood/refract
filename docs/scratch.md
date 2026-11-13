# Scratch files

On 2026-11-13, 16 GB of probe runs and dozens of stale live-check folders in the home folder filled C:. Scratch lives in one place and is always tidied.

- Every scratch file, folder, clone, non-lane worktree, exe copy, data dir (`REFRACT_DATA_DIR`), WebView2 profile, probe run, log, and screenshot goes under `C:/Scratch/<task>/`, one folder per task (for example `C:/Scratch/refract-live-1950`). Never use the home folder, a repo, `C:/tmp`, `%TEMP%`, or the Desktop.
- Lane worktrees stay in `C:/Repos/personal/pinion-worktrees/lane-<n>` and are removed by `pnpm worktrees:reap --apply`. Any other clone or worktree goes in `C:/Scratch/<task>/repo`.
- Keep cited evidence in `C:/Scratch/<task>/evidence/`. At task end, the worker deletes everything else in its folder by literal path; the controller deletes `C:/Scratch/<task>` when the PR merges or the task is dropped.
- No dry runs for cleanup: run reap and cache cleaners with `--apply` directly. Release dry runs and other non-cleanup dry runs are unaffected.
- Deletes follow the destructive-operations rule in `AGENTS.md`: literal absolute paths only, cwd outside the repo.
- Layout of the folder: `C:/Scratch/README.md`.
- Put this rule in every delegation brief, and name the worker's task folder in it.
