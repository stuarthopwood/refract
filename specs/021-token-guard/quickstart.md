# Quickstart: verifying the token guard

Use a scratch debug build (never `pnpm dev`), the shared `CARGO_TARGET_DIR`, and a scratch data dir (`REFRACT_DATA_DIR`); see `scripts/verify-tauri.mjs`.

1. Launch a Session. Read the `omp` process command line: it contains `--config <data dir>\token-guard-overlay.yml` and `--append-system-prompt <data dir>\refract-rules.md`.
2. Change a guarded key in the global OMP config (use a scratch `PI_CODING_AGENT_DIR`). Start a new Session; confirm it still reports the overlay value (omp stats or the Session's settings readout).
3. Open Settings > OMP; every overlay key shows "Set by Refract"; change one, start a new Session, confirm the overlay file holds it; Reset to default restores it.
4. Drive a recorded tape past 60k context; confirm a `/shake` prompt is sent after the turn settles (frame log), none mid-turn, and nothing appears in the transcript.
5. Drive a tape past 300 model calls; confirm the Status line shows "Long conversation" with a Hand off button; Hand off creates a new Conversation whose first message is the summary.
6. Past 500 calls, confirm the pane banner, its dismissal and its return after 100 more calls; confirm a screen reader announcement happens once per threshold.
7. Confirm `~/.omp/agent/config.yml` is no longer touched by Refract (modified time unchanged across launches).
8. Settings > Advanced batch (#1553, #1579, #1555, #1580): the global compaction threshold shows 70 %, the overlay holds `thresholdPercent: 70` and `thresholdTokens: -1`; per-model rows show a percent and "≈ N of W tokens"; the idle row shows a percent and "≈ N tokens"; a seeded version 1 store with token overrides resets once with a note. Number rows step with ArrowUp/ArrowDown and spinners, block `e`/`+`/`-`, and ignore wheel. Descriptions and labels match #1555. At defaults no warning shows; raising a costlier row shows the warning line, including a per-model percent above the global one.
9. Live reload (#1765, #1935): with a Session running, save a live key (the compaction keys, `tools.xdev`, the image compression, subagent, advisor, search and read limits, spill threshold, prewalk and autolearn keys) in Settings > Advanced; on the Session's next turn it uses the new value without a restart. `todo.eager` (startup-only), `plan.defaultOnStartup` and the three idle compaction keys (no effect in Refract Sessions) show "Applies to new Sessions".
