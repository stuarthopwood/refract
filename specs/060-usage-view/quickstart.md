# Quickstart 060: verify the Usage view

Never touch `%APPDATA%\refract-tauri` or `~\.omp`.

1. Make a scratch folder under `%TEMP%` with `data\` and `sessions\`. Put a synthetic fixture in `sessions\`: one main file under a folder named for a cwd, one nested subagent file, `model_change` and `thinking_level_change` lines, a toolCall with its toolResult (one `isError`), a user message with shouting, and a last line cut mid-JSON.
2. Put a fake `omp` (answers `usage --json` with a Copilot report and a second provider) and a fake `gh` (plan snapshot) first on PATH.
3. Build as in `docs/rust-build.md`, copy the exe to a scratch dir, and run it with `REFRACT_DATA_DIR`, `REFRACT_OMP_SESSIONS_DIR` and its own `--remote-debugging-port`.
4. Slice 1: launch the exe without opening Usage, wait for `usage.status` to settle (ingest starts at app launch, #1655), and compare `usage.summary` to the fixture sums. Run `usage.start` again and confirm nothing changed. Append a complete line to the fixture and confirm it lands within 5 minutes (or at once for a Refract Session via the nudge). Complete the cut line and confirm it is counted once.
5. Slice 2: open Usage from the left nav. Check the budget card, the cards and captions, both charts and "View as table", each table's sort by keyboard, every filter and its persistence after relaunch, the Jokes toggle hiding captions and the frustration card, the progress bar while a large generated fixture backfills, and the empty state with an empty `sessions\` folder.
6. Record call-log proof that the fake `omp` was spawned with `usage --json` once per five minutes at most.
7. #1656: after step 4 ingested the fixture, rewrite it keeping its first 256 bytes but changing a later line and adding one, then confirm the next rescan counts the new content once and keeps rows only the old content had. `node scripts/verify-tauri-1656.mjs` does this.
8. #1845: seed a version 3 `usage.db` whose tool tables hold `cost_share` rows, launch, and confirm the rows survive as `cost_usd`, the by-tool table shows percentages, and a window with no priced tool call shows an em dash. `node scripts/verify-tauri-1845.mjs` does this.
