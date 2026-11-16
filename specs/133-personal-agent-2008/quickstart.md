# Quickstart: verifying the Personal Agent

Always use an isolated scratch data folder and instance (see the Refract scratch-instance skills); never point at the real `registry.json`. Scratch files go in `C:/Users/shopwood/AppData/Local/Temp/scratch/<lane>/` and are removed afterwards.

## #2004 data model

1. Seed a scratch data folder with a `registry.json` written before this feature (Sessions have no `kind`).
2. Start the scratch instance (`pnpm verify:tauri` style harness) against it.
3. Expect: `sessions.list` returns every Session as `kind: "project"` with the same repository, branch and worktree path; the session list looks identical (SC-001). After one save, the on-disk Project rows differ only by the added `kind`.
4. Add a `personal` row through the registry (harness call): accepted, with null repository fields. Add a second: refused with `personal-agent-exists`; the file is unchanged.
5. Call `sessions.archive` and `sessions.delete` on the `personal` id: each returns `personal-agent-protected`; no agent is stopped, no file changes (SC-002). `sessions.rename` succeeds.
6. App log shows no error or panic while the list is read with a `personal` row present.

## #2005 create and launch

Open the Personal Agent on a clean data folder; confirm one Session named "My Agent", no worktree on disk, the agent process cwd is the home folder, a message gets a reply, and a second open reuses the Session (SC-003, SC-004). Record the omp non-repository result in `docs/spike/FINDINGS.md`.

Call the create-or-open IPC over CDP on the scratch instance; #2005 adds no UI entry point and #2006 adds the button.

## #2007 repo-only empty state

Open the git changes panel, file explorer, PR view and diff in the Personal Agent: each shows the "No repository" empty state with no backend call and the app log stays clean; the Worktree actions are absent from its menus; the same panels work in a Project Session (SC-005, SC-006).

## #2006 launcher

Check the order launcher, divider, "Projects" heading, groups; button state and rename; keyboard focus ring and selected state; the Personal Agent never inside a group.

## Always

`pnpm ci:local`; no touched file over 600 lines.
