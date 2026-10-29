# Refract keeps its own local usage database

Stuart wants to see where model spend goes: every call, tool call, token and AI credit, by Project, model and reasoning level (#1331). OMP already records each call in its session files (`~/.omp/agent/sessions/**/*.jsonl`) and keeps a stats database (`~/.omp/stats.db`). That database is 554 MB, refreshes only when someone runs `omp stats`, has no reasoning level, and its schema is internal to OMP. On 2026-10-29, in the #1331 grill, Stuart decided that Refract keeps its own database rather than reading OMP's.

Rules:
- Refract stores usage in `usage.db`, a SQLite file in its data folder (`%APPDATA%\refract-tauri`, or `REFRACT_DATA_DIR`). It is never written inside a repository.
- An ingest worker reads OMP's session files incrementally. It tracks a byte offset per file and replays `model_change` and `thinking_level_change` entries, so each call carries its model and reasoning level.
- Refract-launched Sessions also write their rows live on `message_end`.
- The tables copy the shapes of OMP's `messages`, `tool_calls` and rollup tables, plus a reasoning-level column. Refract stores counts, never prompt prose.
- It never reads `stats.db`.

**Consequences:** Refract adds the `rusqlite` dependency (bundled SQLite) and a Rust `usage` module. A change to OMP's session-file format can break ingest, so the OMP release review (#689) checks the usage fields. The first open backfills the full history, about 4,200 files at the time of the grill.