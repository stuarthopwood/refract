# Quickstart: verifying tool-row icons

Use a scratch debug build (never `pnpm dev`), the shared `CARGO_TARGET_DIR` (`C:\Users\shopwood\.cargo-target\refract`, with `CARGO_INCREMENTAL=0` and `CARGO_BUILD_JOBS=4`), and a scratch data directory (`REFRACT_DATA_DIR`), never the real `%APPDATA%\refract-tauri`. `scripts/verify-tauri.mjs` (`pnpm verify:tauri`) does all three: it builds with `pnpm exec tauri build --debug --no-bundle`, copies `refract-tauri.exe` to a scratch folder, and runs it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`.

Drive the recorded-frame `session` fixture first (no model cost). The fixtures with an intent on `tool_execution_start` are `scripts/fixtures/omp-frames/997-notice-severity.jsonl:57` and `ask.jsonl:16`. Do not add fixtures (prototyping rule). For statuses and tools the fixtures do not cover (failed, interrupted, MCP, `xd://` writes, unknown tools), run one short real-`omp` session in the scratch app on a scratch repository and prompt for those calls, then reopen it from history.

Run steps 1 to 9 at the default width and at 360 px, and step 6 on each of the five themes (Dark, Dark (high contrast), Obsidian, Nordic Frost, Cyber Amber). Save a screenshot of the transcript per theme and of Settings.

1. Layout (FR-001, FR-010): each tool row reads tool icon, label, muted summary, then the status icon and duration on the right. Thought rows have no tool icon (FR-022).
2. Labels (FR-003, FR-007, SC-001): a row with an intent shows the intent. A row with no intent shows the running form while running and the done form when done ("Reading", "Read"). A failed `grep` with no intent reads "Search text"; a failed `bash` reads "Run". No row shows a raw tool id unless it is an unknown or MCP tool's sentence-case name. A `bash` summary has no `$ `; a `grep` summary has no leading `grep`.
3. Special tools (FR-004, FR-005, FR-013, FR-018): an `mcp__x_y` row shows Plug and "X y"; an unknown tool shows Wrench and its sentence-case name; a `write` to `xd://<tool>` shows that tool's icon and verb and does not group with plain writes; a `wait` row shows Hourglass and what it waits for, not the intent repeated.
4. Groups (FR-014): consecutive reads show "Read ×N" with FileText; each member shows its own label.
5. Tooltip (FR-011, SC-003): hovering the icon shows the raw id (`write xd://<tool>` for an `xd://` write). Tab to a row: the tooltip opens while its trigger has focus, and the number of tab stops in the transcript is unchanged.
6. Contrast (FR-020, SC-004): the tool icon is muted and reaches 3:1 against the row in each theme; on a failed row it takes the error colour. Run `pnpm check:theme-contrast`. In forced-colours mode both icons stay visible.
7. Setting (FR-012, SC-006): Settings shows "Show tool names on rows" after "Show tool calls", off by default. Turning it on adds the muted raw id after every label within one second; it survives an app restart (relaunch the scratch exe with the same `REFRACT_DATA_DIR`).
8. Accessible names (FR-015): a failed row's name starts "Failed", then the label, the raw id when the setting is on, and the target. The icon is not in the accessibility tree.
9. Other surfaces and history (FR-016, FR-017, FR-019, SC-007): an Ask-mode approval card shows the tool icon beside the unchanged "Allow tool: <id>"; a subagent row shows Users with the agent's name and its status glyph on the right; the tool-call dialog title keeps the raw id. Reopen the real-`omp` Conversation from history: every row shows the same label it had live.

Gate before and after the live check: `node scripts/ci-local.mjs` (covers `pnpm typecheck`, `pnpm test`, `check:file-size`, `check:parity`, `check:ui-text`, `check:theme-contrast` and the cargo checks).
