# Data model 060: `usage.db`

SQLite, `PRAGMA user_version = 4`, WAL. Shapes follow OMP's `messages`, `tool_calls`, `user_messages` and rollups (ADR 0006) plus `reasoning`. No prompt prose in any column.

| Table | Key | Columns |
| --- | --- | --- |
| `file_offsets` | `session_file` | `offset`, `last_modified`, `session_id`, `cwd`, `agent_type` (`main`/`subagent`), `project_label`, `file_len`, `cur_model`, `cur_reasoning` (the last two carry `model_change` and `thinking_level_change` state across a resumed read), `head_len`, `head_hash` (FNV-1a of the file's first up-to-256 bytes, to detect a rewrite), `tail_len`, `tail_hash` (FNV-1a of the up-to-256 bytes ending at `offset`; length 0 means unknown) |
| `messages` | `(session_file, entry_id)` | `ts` (ms), `session_id`, `provider`, `model`, `reasoning`, `agent_type`, `purpose`, `project_label`, `input`, `output`, `cache_read`, `cache_write`, `total_tokens`, `cost_total`, `cost_input`, `cost_output`, `cost_cache_read`, `cost_cache_write`, `credits` (null unless `github-copilot`), `premium_requests`, `duration_ms`, `ttft_ms`, `stop_reason` |
| `tool_calls` | `(session_file, tool_call_id)` | `ts`, `entry_id` (issuing message), `tool`, `is_error` (null until the result lands), `result_chars`, `cost_usd` (the issuing call's dollars split equally among its tool calls), plus the labels copied from the message (`project_label`, `model`, `reasoning`, `agent_type`) |
| `user_messages` | `(session_file, entry_id)` | `ts`, `chars`, `yelling`, `profanity`, `blame`, `project_label` |
| `message_rollup` | `(hour, project_label, model, reasoning, agent_type)` | sums of the token, cost, credits columns and `calls` |
| `tool_rollup` | `(hour, project_label, tool, agent_type)` | `calls`, `errors`, `result_chars`, `cost_usd` |
| `session_rollup` | `session_file` | `session_id`, `first_ts`, `last_ts`, `calls`, `cost_total`, `credits`, `project_label` |
| `prefs` | `key` | `value` (JSON): `jokes`, `filters` |

Indexes: `messages(ts)`, `messages(project_label, ts)`, `messages(model, reasoning, ts)`, `tool_calls(tool, ts)`, `user_messages(ts)`.

Rules:

- Rollups are updated in the same transaction as the rows that feed them, by `INSERT ... ON CONFLICT DO UPDATE` adding the delta. A tool result that lands later updates `tool_calls` and adds only its delta (`errors`, `result_chars`) to `tool_rollup`.
- `hour` is the UTC hour start in ms. Day buckets are derived at query time from the hour rollup using `tzOffsetMinutes`. In a time zone that is not a whole number of hours (India, Nepal, Newfoundland) day buckets read `messages` by exact `ts` instead.
- Rollup windows are exact: whole hours come from the rollup, and a partial boundary hour (a rolling 7d/30d, a half-hour zone's local midnight, a custom range) comes from `messages`/`tool_calls` by exact `ts`, so cards agree with the call log and top sessions.
- A rewritten file (head fingerprint differs, the window ending at the stored offset differs, or it is shorter than the stored offset) is re-read from 0; the `(session_file, entry_id)` dedupe makes that double-count-safe. Rows the rewrite removed stay.
- Known limitation: dedupe is per file, so a forked copy of a session file that repeats entry ids counts twice.
- Per-call log and the Project filter read `messages` directly (indexed); cards, charts and the by-model, by-Project and by-tool tables read rollups.
- `usage.topSessions` reads `session_rollup` only when no model, reasoning or agent-type filter is set; otherwise it groups `messages` by session (indexed by `ts`).
- A `project_label` is resolved once per file at ingest (cwd, then Projects and Worktrees); relabelling after a Project is added is a `usage.relabel` step in the worker that rewrites labels and rebuilds rollups for changed files.
- `usage.db` is derived data: corruption, a future `user_version` or version 1 renames the file to `usage.db.bak-<unix-ts>` and rebuilds. Version 2 gains `tail_len` and `tail_hash` in place (`user_version` 3). Version 3 renames `cost_share` to `cost_usd` on `tool_calls` and `tool_rollup` in place (`user_version` 4), keeping its history.
- The by-tool Cost share is computed at query time: a tool's `cost_usd` over the sum across tools in the window. When that sum is zero (no model priced) the share is absent and the table shows an em dash.
