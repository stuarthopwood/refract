# Quickstart: token guard live verification (#1935)

1. `pnpm install --frozen-lockfile` (once per worktree).
2. `omp --version` and note it; the report records it.
3. `pnpm probe:token-guard -- --out <scratch>/report.json` runs every group. `--group tools|snapcompact|subagents|prompt|autolearn|advisor|idle` runs one.
4. The command prints one line per key: `key  verdict  observable  control  test`. Run it twice; the verdicts must agree (FR-003).
5. Copy the verdicts into `specs/021-token-guard/research.md` section 11, set `live: true` in `src/shared/tokenGuard.ts` for each `live` key, and update `LIVE_KEYS` in `src/shared/tokenGuard.test.ts`.
6. `pnpm test` and `pnpm ci:local`.

The probes use a scratch `PI_CODING_AGENT_DIR` and a scripted local provider. They never read `~/.omp` or `%APPDATA%\refract-tauri`, and they never create a `WATCHDOG.yml`.
