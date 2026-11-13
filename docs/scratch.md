# Scratch files

On 2026-11-13, 16 GB of probe runs and dozens of stale live-check folders in the home folder filled C:. Scratch lives in one place (`%TEMP%\scratch\<task>\`, which is `C:/Users/shopwood/AppData/Local/Temp/scratch/<task>/`) and is always tidied.

- Every scratch file, folder, clone, non-lane worktree, exe copy, data dir (`REFRACT_DATA_DIR`), WebView2 profile, probe run, log, and screenshot goes under `%TEMP%\scratch\<task>\`, one folder per task (for example `%TEMP%\scratch\refract-live-1950`). Never use the home folder, a repo, `C:/tmp`, loose files in `%TEMP%` outside `%TEMP%\scratch`, or the Desktop.
- Lane worktrees stay in `C:/Repos/personal/pinion-worktrees/lane-<n>` and are removed by `pnpm worktrees:reap --apply`. Any other clone or worktree goes in `%TEMP%\scratch\<task>\repo`.
- Keep cited evidence in `%TEMP%\scratch\<task>\evidence\`. At task end, the worker deletes everything else in its folder by literal path; the controller deletes `%TEMP%\scratch\<task>` when the PR merges or the task is dropped.
- No dry runs for cleanup: run reap and cache cleaners with `--apply` directly. Release dry runs and other non-cleanup dry runs are unaffected.
- Disk cleaners may remove it, so a PR must not depend on scratch evidence surviving.
- Deletes follow the destructive-operations rule in `AGENTS.md`: literal absolute paths only (write out `C:/Users/shopwood/AppData/Local/Temp/scratch/<task>`, never `%TEMP%` or a variable, in a delete command), cwd outside the repo.
- Layout of the folder: `%TEMP%\scratch\README.md`.
- Put this rule in every delegation brief, and name the worker's task folder in it.
