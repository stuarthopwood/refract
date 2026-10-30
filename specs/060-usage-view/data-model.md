# Data model 060: `usage.db`

SQLite, `PRAGMA user_version = 1`, WAL. Shapes follow OMP's `messages`, `tool_calls`, `user_messages` and rollups (ADR 0006) plus `reasoning`. No prompt prose in any column.

| Table | Key | Columns |
| --- | --- | --- |
| `file_offsets` | `session_file` | `offset`, `last_modified`, `session_id`, `cwd`, `agent_type` (`main`/`subagent`), `project_label` |
| `messages` | `(session_file, entry_id)` | `ts` (ms), `session_id`, `provider`, `model`, `reasoning`, `agent_type`, `purpose`, `project_label`, `input`, `output`, `cache_read`, `cache_write`, `total_tokens`, `cost_total`, `cost_input`, `cost_output`, `cost_cache_read`, `cost_cache_write`, `credits` (null unless `github-copilot`), `premium_requests`, `duration_ms`, `ttft_ms`, `stop_reason` |
| `tool_calls` | `(session_file, tool_call_id)` | `ts`, `entry_id` (issuing message), `tool`, `is_error` (null until the result lands), `result_chars`, `cost_share`, plus the labels copied from the message (`project_label`, `model`, `reasoning`, `agent_type`) |
| `user_messages` | `(session_file, entry_id)` | `ts`, `chars`, `yelling`, `profanity`, `blame`, `project_label` |
| `message_rollup` | `(hour, project_label, model, reasoning, agent_type)` | sums of the token, cost, credits columns and `calls` |
| `tool_rollup` | `(hour, project_label, tool, agent_type)` | `calls`, `errors`, `result_chars`, `cost_share` |
| `session_rollup` | `session_file` | `session_id`, `first_ts`, `last_ts`, `calls`, `cost_total`, `credits`, `project_label` |
| `prefs` | `key` | `value` (JSON): `jokes`, `filters` |

Indexes: `messages(ts)`, `messages(project_label, ts)`, `messages(model, reasoning, ts)`, `tool_calls(tool, ts)`, `user_messages(ts)`.

Rules:

- Rollups are updated in the same transaction as the rows that feed them, by `INSERT ... ON CONFLICT DO UPDATE` adding the delta. A tool result that lands later updates `tool_calls` and adds only its delta (`errors`, `result_chars`) to `tool_rollup`.
- `hour` is the UTC hour start in ms. Day buckets are derived at query time from the hour rollup using `tzOffsetMinutes`.
- Per-call log and the Project filter read `messages` directly (indexed); cards, charts and the by-model, by-Project and by-tool tables read rollups.
- `usage.topSessions` reads `session_rollup` only when no model, reasoning or agent-type filter is set; otherwise it groups `messages` by session (indexed by `ts`).
- A `project_label` is resolved once per file at ingest (cwd, then Projects and Worktrees); relabelling after a Project is added is a `usage.relabel` step in the worker that rewrites labels and rebuilds rollups for changed files.
- `usage.db` is derived data: corruption or a future `user_version` renames the file to `usage.db.bak-<unix-ts>` and rebuilds.
