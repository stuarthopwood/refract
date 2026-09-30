# Pinion agent rules

## Destructive operations (HARD RULE)

On 2026-09-30 a worker ran `rm -rf "C:/tmp/a" "C:${unsetVar:-}"`. The variable was not a shell variable, so the target became `"C:"`. On Windows a bare `C:` is the current directory on drive C:, inherited from the parent process. This repository was deleted, and the restored copy was deleted the same way.

- Delete only literal absolute paths you can read in the command. Never build a target from a variable, `${x:-}`, `$(...)`, a glob, or concatenation.
- Never pass `""`, `.`, `..`, `~`, `*`, `./*`, or a bare drive (`C:`, `C:\`) to rm, rmdir, del, Remove-Item, rimraf, fs.rm, or shutil.rmtree. A bare `X:` means `.`.
- Never delete inside this repo except named scratch files (for example `out/`, `dist/`, `node_modules/` by literal relative path). Clean up from a cwd outside the repo.
- Never run `git clean -f`, `git reset --hard`, `git checkout .`, or `git restore .` without the user approving that exact command.
- List the literal target first, then delete.
- Test destructive guards only against a canary you create under the temp dir, never against `.`, `..`, `~`, or a bare drive.
- Commit verified work after every wave and push. Do not leave hours of work uncommitted.
- When you delegate, put this list in the brief.
