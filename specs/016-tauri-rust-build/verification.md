# Verification record: Rust (Tauri v2) build, milestone 1

**Date**: 2026-10-13

**Build**: `feat/780-tauri-rust`, branch head at the point the fixes below were committed (latest
fix commit `2a78831`, `PendingRequest` `rename_all_fields`).

**Environment**: Windows 11, dev (unoptimized) builds of both the Rust (`pnpm dev:tauri`) and
Electron (`pnpm dev`) shells, isolated scratch repository and data directories (never Stuart's real
profile). Evidence PNGs and the raw session log referenced below are under
`C:/Users/shopwood/AppData/Local/Temp/refract-tauri-verify/` (see `notes.md` there for the full
narrative this record summarizes).

## Per-story results

| Check | Result | Evidence | Notes |
|---|---|---|---|
| US1 -- run the build, see Repositories | PASS | p4-00-initial.png, cdp-01-initial.png | Window themed on first paint; readiness reported `omp` found, version 18.10.1, signed in. Warning: 18.10.1 is outside the re-probed supported range of 18.8.x -- worth re-checking the version floor. |
| US2 -- add a repository | PASS (partial) | p4-electron-01-typed-path.png, cdp-02-session-opened.png | Verified via the dialog's typed-path field. The native folder picker (`repositories.pickFolder`) was NOT driven by this pass; still unverified live. |
| US3 -- create and open a Session | PASS | p4-01-calm-martin-open.png | Session `calm-martin` created; worktree present on disk; `omp.exe` confirmed a child process of `refract-tauri.exe` with cwd set to the worktree, read from the process PEB. |
| US4 -- chat with a streamed answer | PASS | p4-04-sent-hello.png, cdp-06-reply.png | Prompt "Reply with the single word ok" streamed back "ok" via `transcript:patch` upserts. |
| US5 -- answer an approval request | PASS | p4-05-sent-hello.png, p4-06-approved-hello.png, p4-07-hello-turn-settled.png, p4-09-sent-bye.png, p4-10-denied-bye.png | Fixed by commit `2a78831` (`PendingRequest` needed `rename_all_fields = "camelCase"`, not just `rename_all`, so struct-variant fields serialized to camelCase). Approve created `hello.txt` with content `hi`; Deny left `bye.txt` absent from the worktree. |
| US6 -- stop the agent | PASS | p4-12-actions-menu.png, p4-13-stopped.png | Stopped from the UI (Session actions menu); status flipped to Stopped; `omp` pid 26824 confirmed gone via `Win32_Process`. |
| US7 -- reopen the app, see Sessions and history | PASS | p4-14-relaunch.png, p4-15-us7-history.png | Full process restart (not just window close): Repository, both Sessions, and the prior Conversation history (the US4 and US5 turns) all reappeared after relaunch. |
| Job Object force-kill (SC-004) | PASS | — (Win32_Process before/after query, see notes.md) | `taskkill /PID 18336 /F` (no `/T`) against `refract-tauri.exe`; its `omp.exe` (pid 26452) and all 5 MCP-server children were gone within ~3 seconds, confirming `CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` tears down the whole descendant tree even without an explicit tree-kill flag. |

## Fixes found and applied during this live run

- Vite watcher `EBUSY` on `src-tauri/target` (dev server watching Rust build output).
- `readiness.rs` had `ompSignedIn` hard-coded to `false`.
- `session/agent.rs`'s runtime view was missing `transcript`/`queue`/`pending` fields.
- `PendingRequest`'s serde attribute used `rename_all` (variant tags only) instead of
  `rename_all_fields` (also renames struct-variant fields), breaking the approval-card
  `requestId` match (fixed in `2a78831`, re-verified live above under US5).

## Footprint measurement (SC-005)

Both builds measured as dev (unoptimized) builds, two idle Sessions each, using
`Get-CimInstance Win32_Process` `PrivatePageCount` and `WorkingSetSize`, summed per process tree,
app side and omp side reported separately.

| Build | Side | Processes | Private | Working set |
|---|---|---|---|---|
| Rust (`pnpm dev:tauri`) | App (`refract-tauri.exe` + 6 `msedgewebview2.exe`, 7 procs) | 7 | 444.8 MB | 579.2 MB |
| Rust (`pnpm dev:tauri`) | OMP (both Sessions' `omp.exe` + MCP-server children, 34 procs) | 34 | 2074.9 MB | 1685.8 MB |
| Electron (`pnpm dev`) | App (`electron.exe` tree, 4 procs, excludes omp) | 4 | 371.3 MB | 514.6 MB |
| Electron (`pnpm dev`) | OMP (both Sessions' `omp.exe` + MCP-server children, 34 procs) | 34 | 2127.4 MB | 1641.1 MB |

`electron-vite`'s own dev Node process (215.7 MB private / 163.7 MB working set) is reported
separately and excluded from the Electron app-side total above: it is a dev-only process not
present in a packaged build. The Rust build's own Vite/Tauri CLI dev processes were likewise
excluded from the Rust app-side total, for the same reason.

**Conclusion**: in these dev builds, the Rust app side is about 20% higher than the Electron app
side; the omp side (both Sessions' agents and their MCP children) is effectively the same across
both builds, as expected since that side is identical `omp.exe` processes in either build.

## Parity (milestone 1, `parity.md`)

- 21 of 32 milestone-1 rows: done, live-verified this pass.
- 1 of 32: partial (`repositories.pickFolder` -- implemented and reachable via the typed-path
  fallback, but the native folder picker itself was not exercised live).
- 10 of 32: not exercised live this pass (implemented and compiling, not live-verified):
  `repositories.remove`, `repositories.branches`, `sessions.rename`, `clipboard.writeText`,
  `conversations.list`, `conversations.open`, `chat.stop`, `settings.setApprovalMode`,
  `commands:update`, `settings:changed`.

`parity.md`'s own "Rust status" column reflects this breakdown and was not altered by this
record -- its per-row statuses were already accurate before this verification pass.

## Not verified

- `repositories.pickFolder`'s native OS folder-picker dialog itself (the typed-path fallback was
  used instead for US2).
- `settings.setApprovalMode` and the resulting `settings:changed` event fan-out.
- `clipboard.writeText` (copying chat text and confirming the system clipboard received it).
- `conversations.list` / `conversations.open` as distinct from the Conversation history shown
  automatically by the US7 restart check.
- `sessions.rename`, `repositories.remove`, `repositories.branches`, `chat.stop`,
  `commands:update` as standalone live checks (covered only by compilation and code review).
