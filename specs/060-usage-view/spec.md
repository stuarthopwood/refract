# Spec 060: Usage view (#1331)

A Usage view: a stats dashboard of every model call, tool call, token and AI credit OMP has spent on this machine, filterable by date, Project, model, reasoning level and agent type, with the remaining AI-credit budget and a sense of humour. Refract keeps its own `usage.db` (ADR 0006); it never reads OMP's `stats.db`.

## Clarifications

Grill outcomes are Stuart's (2026-10-29, grill-with-docs, recorded on #1331, none deferred). Items marked "Decided (Skippy, delegated by Stuart 2026-10-30)" are decided by the director on Stuart's behalf and binding.

### Session 2026-10-30

- **Store (grill 1, ADR 0006):** `usage.db` in `lib.rs::data_dir()` (`%APPDATA%\refract-tauri`, or `REFRACT_DATA_DIR`), never in a repo. Table shapes copy OMP's `messages`, `tool_calls`, `user_messages` and rollups plus a reasoning-level column. Counts only, no prompt prose. Keep everything.
- **Scope (grill 2):** every OMP session on the machine. Each call carries a **Project** label. A Refract Project or one of its Worktrees takes the Project's name; any other folder shows as its path.
- **Placement (grill 3):** left-nav **Usage** in the same shell as Pull requests and Issues; Command palette entry "Open Usage" (#5).
- **Content (grill 4):** eight headline cards (spend, AI credits, model calls, total tokens, cache hit rate, average context per call, tool calls, tool error rate); spend over time stacked by model (day or hour); token mix with each type's cost share; tables by Project, by model and reasoning level, by tool, top ten sessions, and a per-call log. Filters: Today, 7 days, 30 days, All, Custom; Project; model; reasoning level; main vs subagent.
- **Budget (grill 5):** Copilot row from the #1238 fetch; one row per other provider from `omp usage --json`; burn-rate line; non-Copilot calls show USD instead of credits.
- **Humour (grill 6):** fixed caption templates chosen by value, and a frustration index card (yelling, profanity, blame counts, mood sparkline) from local regex scoring, no model calls. On by default; Settings toggle "Jokes on the Usage view" hides both.
- **Ingest (grill 7):** first open backfills all history in the background with a progress bar; the dashboard fills as data arrives. Refract Sessions land live; other sessions are picked up on open and every five minutes while the view is open.
- **Priority (grill 8):** p1.
- **Field names verified (2026-10-30, read-only on real OMP files):** an assistant entry is `{type:"message", id, parentId, timestamp, message:{role:"assistant", provider, model, api, usage:{input, output, cacheRead, cacheWrite, totalTokens, cost:{input, output, cacheRead, cacheWrite, total}, premiumRequests}, stopReason, duration, ttft, purpose?}}`. `model_change` carries `model` as `provider/model`; `thinking_level_change` carries `thinkingLevel`. A `toolResult` message has `toolCallId`, `toolName`, `isError`; an assistant `toolCall` content block has `id`, `name`, `arguments`. `model_usage` entries (side calls such as `unexpected-stop`) carry `purpose`, `provider`, `model`, `usage`. The first `session` entry holds `cwd`. Subagent files live in a folder named after the parent session file (for example `<session>/__advisor.jsonl`).
- **AI credits per call (Decided (Skippy, delegated by Stuart 2026-10-30)):** `usage.cost.total` times 100 when the provider is `github-copilot` (1 credit = $0.01), the definition the context pill already uses (`session/ai_credits.rs`, #1238). This replaces the issue's `[INFERENCE]` multiplier table. Evidence: `omp usage --json` reports the Copilot monthly limit as 2,000,000 "requests" with 69,402 used, which is the same unit; `~/.omp/agent/models.db` holds a `premiumMultiplier` per Copilot model but it is not what the plan bills. `usage.premiumRequests` is stored as recorded but not shown. Other providers show list-price USD only.
- **Single writer (Decided (Skippy, delegated by Stuart 2026-10-30)):** the ingest worker is the only writer. A Refract Session's `message_end` does not parse the event; it nudges the worker to tail that Session's file now. This avoids double counting between "live" rows and file ingest while still landing the row within a second. Dedupe key: `(session_file, entry_id)`; tool calls `(session_file, tool_call_id)`.
- **Project label source (Decided (Skippy, delegated by Stuart 2026-10-30)):** the `cwd` in the file's `session` entry, not the lossy folder name. The folder name is the fallback when the header is missing. A cwd matches a Project when its normalised path equals the Project path or a Worktree path of it, or lies beneath it (Windows: case-insensitive, `\\?\` stripped, `/` folded).
- **Agent type (Decided (Skippy, delegated by Stuart 2026-10-30)):** `main` for a top-level `*.jsonl`; `subagent` for any file in a nested folder (advisor and task subagents). `model_usage` rows take the type of their file and keep `purpose`.
- **Tool rows (Decided (Skippy, delegated by Stuart 2026-10-30)):** one row per assistant `toolCall`, joined to its `toolResult` by `toolCallId` (upsert, because the result can land in a later ingest pass). Result size is the character count of the result text; the text is not stored. Cost: the issuing call's dollars split equally among that call's tool calls, stored as `cost_usd`. Cost share (Decided (Stuart 2026-11-11, #1845)): shown as a percentage of the window's tool spend, and an em dash when nothing in the window was priced.
- **Context and cache (Decided (Skippy, delegated by Stuart 2026-10-30)):** context per call = `input + cacheRead + cacheWrite`; cache hit rate = `cacheRead / (input + cacheRead + cacheWrite)` over the filtered calls.
- **Frustration scoring (Decided (Skippy, delegated by Stuart 2026-10-30)):** applied to real user messages only (`role: user`, not `synthetic`). Yelling: at least 8 letters and over 70% upper-case, or three or more `!`. Profanity: a fixed word list. Blame: a fixed phrase list ("you broke", "your fault", "why did you", "I told you"). Each stored as a per-message count plus length; mood = daily mean of (yelling + profanity + blame) per message. Lists live in one Rust file, ASCII only, case-insensitive.
- **Time buckets (Decided (Skippy, delegated by Stuart 2026-10-30)):** rollups are per UTC hour; the renderer passes `tzOffsetMinutes` and the day bucket is computed from the hour rollup in that offset.
- **Budget figures (Decided (Skippy, delegated by Stuart 2026-10-30)):** `copilot_plan.rs` gains `plan_snapshot()` (percent used, entitlement, remaining) beside `plan_percent_used()`. Reset date comes from the Copilot report of `omp usage --json` (`reports[].limits[].window.resetsAt`, verified), falling back to the first of next month UTC. Burn rate = credits spent in the last 7 days divided by 7, applied to remaining credits; shown only with at least 24 hours of data. Other providers: one row per `reports[]` entry other than `github-copilot`, showing each limit's `label`, `amount.used`, `amount.limit`, `amount.unit` and `window.resetsAt`; an entry that does not parse shows "Budget unavailable".
- **Prefs home (Decided (Skippy, delegated by Stuart 2026-10-30)):** the Jokes toggle and the persisted filters live in a `prefs` table in `usage.db`, read and written by `usage.getPrefs` and `usage.setPrefs`. `Settings` (in `ipc.ts`, at its cap) gains nothing. The Settings toggle calls the same channel.
- **Sessions-dir override (Decided (Skippy, delegated by Stuart 2026-10-30)):** `REFRACT_OMP_SESSIONS_DIR` (absolute path) replaces `~/.omp/agent/sessions`, so live checks never touch the real folder. Resolved by the same pure override logic as `REFRACT_DATA_DIR`.
- **Schema version (Decided (Skippy, delegated by Stuart 2026-10-30)):** `PRAGMA user_version`. A newer-than-known or corrupt `usage.db` is renamed to `usage.db.bak-<unix-ts>` and rebuilt by backfill; it is derived data and never precious. Amended 2026-11-11 (#1845): v3 to v4 renames `cost_share` to `cost_usd` in place so history survives; versions 2 and 3 migrate in place, older versions still rebuild.
- **Command palette (Decided (Skippy, delegated by Stuart 2026-10-30)):** #5 has not landed (no palette code exists). Slice 2 exports a single `usageViewAction` descriptor (`id`, `label: 'Open Usage'`, `run: openUsage`) and registers it when #5 lands; until then the left-nav entry is the way in. The registration is not a blocker for this story.
- **Split (Decided (Skippy, delegated by Stuart 2026-10-30)):** two stacked PRs. Slice 1 is Rust and contract with no UI, mergeable and live-checkable on its own via the IPC. Slice 2 is the renderer.
- **Untrusted text:** Project paths, model ids, tool names and OMP provider labels render as text only.

### Session 2026-11-05 (#1655)

Grill outcomes are Stuart's (2026-11-04, grill-with-docs, recorded on #1655, none deferred). They supersede the "Ingest (grill 7)" start rule and the stop half of FR-006.

- **Start at launch (grill 1):** the ingest service starts in Rust app setup, so session files rotated, compacted or deleted while the Usage view was closed are still read. Opening the view does not create a second service.
- **`usage.start` kept (grill 2):** it stays as an idempotent IPC, so the view still works if the launch start failed. It returns the status of the running service. A failed launch start (for example, `usage.db` unavailable) is logged, retried on the five-minute timer, and surfaced by the existing `usage-db-unavailable` error state of the view.
- **`usage.stop` removed (lane decision, clean cutover):** a stop on view close would end launch ingest and defeat the fix, and nothing else called it. The renderer's holder set (`usage-service.ts`), the `stop` bridge method, `USAGE_STOP`, the Rust handler, `UsageService::stop`, its `Msg::Stop` and the scan `stop` callback are deleted.

### Session 2026-11-05 (#1656)

- **Rewrite detection (Decided (Stuart, grill-with-docs 2026-11-04, recorded on #1656)):** a session file OMP rewrote with the same head, at least as long as the stored offset, resumed inside new content and skipped rows. Ingest also fingerprints the up-to-256 bytes that end at the stored offset; a mismatch restarts the file from byte 0 and the `(file, entry id)` dedupe keeps rows unique. Rows a rewrite removed stay in `usage.db` (usage history is append-only).
- **Migration (Decided (Skippy, delegated by Stuart 2026-11-05)):** `user_version` 2 to 3 adds `tail_len` and `tail_hash` with `ALTER TABLE`, defaulting to 0 (unknown: the next pass records the window without a reset). A rebuild would drop the rows a rewrite removed, so version 2 is migrated in place; version 1 still rebuilds.

## Functional requirements

- FR-001: `MainView` gains `'usage'`; a left-nav Usage entry (ChartColumnIcon) sits in the GitHub nav group after Issues, `aria-current` when active.
- FR-002: `usage.db` lives in `data_dir()`, opened with the `bundled` rusqlite, WAL, one writer connection on the ingest thread and short read connections for queries. The ingest never runs on the IPC thread.
- FR-003: Ingest scans `<sessions dir>/**/*.jsonl`, keeps `file_offsets(session_file, offset, last_modified)`, reads only complete lines from the stored offset, and commits rows and the new offset in one transaction. A file shorter than its offset restarts from 0.
- FR-004: Per file, `model_change` and `thinking_level_change` are replayed in order so each call carries its model and reasoning level.
- FR-005: Ingest is idempotent: re-reading a file adds nothing (FR dedupe keys above).
- FR-006: Ingest starts during app setup (Tauri `setup`, after app state exists), not when the view opens, then rescans every five minutes for the life of the app (#1655). `usage.start()` stays as an idempotent IPC: it returns `UsageStatus` and queues an incremental scan, which also retries a launch start that failed. There is no `usage.stop`; nothing ends ingest short of quitting. `usage.status()` reports sessions seen, sessions done, and whether an ingest is running. A `usage.progress` event reports the same.
- FR-007: A Refract Session's `message_end` nudges the worker for that Session's file.
- FR-008: `usage.summary(filters)` returns the cards; `usage.timeseries(filters, bucket, tzOffsetMinutes)`; `usage.tokenMix(filters)`; `usage.breakdown(filters, by)` for `project`, `model`, `tool`; `usage.topSessions(filters)`; `usage.calls(filters, sort, page)`; `usage.frustration(filters)`. All SQL-side, over rollups where the shape allows.
- FR-009: Filters are `{range, from?, to?, project?, model?, reasoning?, agentType?}`; every card, chart and table honours them.
- FR-010: `usage.budget()` returns the Copilot row (from `plan_snapshot()`), the other-provider rows (from `omp usage --json`, spawned with argv and no shell, 10 second timeout, cached 5 minutes), and a reason when unavailable.
- FR-011: `usage.getPrefs()` and `usage.setPrefs(patch)` persist `jokes` (default true) and the last filters.
- FR-012: The Usage view shows the budget card, the headline cards, charts, tables, the frustration card (jokes on) and captions (jokes on). Empty state names the folder searched. First-open progress shows `role="progressbar"` with a value and a polite live region on completion.
- FR-013: Charts offer "View as table"; series differ by pattern and direct label as well as colour; tables sort with the keyboard and expose `aria-sort`; each card is one readable unit (value plus caption).
- FR-014: The top-ten table opens the Session when Refract knows its Conversation file; otherwise the row is not a link.
- FR-015: No prompt prose is stored or sent to the renderer. The call log shows timestamp, Project, model, reasoning, agent type, tokens, cost or credits, and duration.
- FR-016: `src/shared/ipc.ts` gains no lines; the contract is `src/shared/ipc-usage.ts`. Every new Rust file is under 600 lines.
- FR-017: `REFRACT_OMP_SESSIONS_DIR` overrides the sessions folder.
- FR-018: Slice 2 uses shared components only (ADR 0003); a chart primitive is added to `components/ui/`.
- FR-019: Ingest stores a fingerprint of the up-to-256 bytes ending at the saved offset (`file_offsets.tail_len`, `tail_hash`). A resumed file whose head or that window no longer matches restarts from byte 0 (FR-003, FR-005 keep it duplicate-free). An empty window (a database from before the column) is unknown: no reset, and the next pass records it.

## Success criteria

- SC-001: After first open on a real machine the totals equal the sum of `usage.cost.total` over the session files within rounding, and a second ingest changes nothing.
- SC-002: With a 4,200-file history the view shows partial data within 5 seconds of opening and the UI thread never blocks.
- SC-003: Every filter combination returns in under 300 ms once backfill is done.
- SC-004: With jokes off no caption or frustration text is rendered.
- SC-005: A session file rewritten so its first 256 bytes and its length-or-more are intact but the bytes before the old offset differ is re-read in full on the next pass: every row of the new content is present exactly once, and rows only the old content had are kept.

## Edge cases

Truncated last line (offset stays before it); file rewritten shorter; file rewritten with the same head but different content before the old offset (#1656); unknown provider or model (kept, no credits); `usage` missing on an assistant entry (skipped); signed-out Copilot (budget unavailable with reason); `omp` missing (other providers absent, no error banner); `usage.db` locked or corrupt (rebuild); `usage.db` at version 2 (migrated in place); sessions folder missing (empty state with the path).

## Deferred

Copilot desktop usage (not in OMP's files); model-written commentary; the #521 usage-limit stage indicator (separate, complementary); Command palette registration until #5.
